import type { TuiAgent } from '../../shared/agent-launch/catalog/tui-agent'
import type {
  AgentUpdateRow,
  AgentUpdatesState
} from '../../shared/agent-updates/agent-update-types'
import { checkAgentUpdates, type AgentUpdateSettings } from './check-agent-updates'
import { runAgentUpdate, type AgentUpdateRunOutcome } from './run-agent-update'

/** A refresh inside this window reuses the last check instead of probing every agent again. */
const AGENT_UPDATE_CACHE_TTL_MS = 6 * 60 * 60 * 1000
/** After a check that proved nothing (offline, rejected), the next one waits this long. */
const AGENT_UPDATE_RETRY_AFTER_FAILURE_MS = 60 * 60 * 1000

type AgentUpdatesListener = (state: AgentUpdatesState) => void

let rows: AgentUpdateRow[] = []
let checking = false
let checkedAt: number | null = null
let retryNotBefore = 0
let checkedSettingsKey: string | null = null
let inFlightCheck: Promise<AgentUpdatesState> | null = null
// Why: "update all" must not run several `npm install -g` at once, so every run joins one queue.
let runQueue: Promise<void> = Promise.resolve()
const listeners = new Set<AgentUpdatesListener>()

export function getAgentUpdatesState(): AgentUpdatesState {
  return { rows, checking, checkedAt }
}

export function onAgentUpdatesChanged(listener: AgentUpdatesListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

// Why: a check is only valid for the settings it ran with; disabling an agent or changing its command must not wait out the cache.
function settingsKey(settings: AgentUpdateSettings): string {
  return JSON.stringify([
    [...settings.disabledTuiAgents].sort(),
    Object.entries(settings.agentCmdOverrides).sort(([a], [b]) => a.localeCompare(b))
  ])
}

function isDisabled(agent: TuiAgent, settings: AgentUpdateSettings): boolean {
  return settings.disabledTuiAgents.includes(agent)
}

function notify(): void {
  const state = getAgentUpdatesState()
  for (const listener of listeners) {
    // Why: a failing listener must never reach the check or run bookkeeping.
    try {
      listener(state)
    } catch (error) {
      console.error('[agent-updates] state listener failed', error)
    }
  }
}

function setRows(next: AgentUpdateRow[]): void {
  rows = next
  notify()
}

function withoutDoneRows(current: readonly AgentUpdateRow[]): AgentUpdateRow[] {
  return current.filter((entry) => entry.run?.state !== 'done')
}

// Why: a failed run stays visible until it is retried or a re-check finds the agent up to date;
// a running row stays because its outcome has not arrived yet.
function mergeCheckedRows(checked: readonly AgentUpdateRow[]): AgentUpdateRow[] {
  const previous = new Map(rows.map((entry) => [entry.agent, entry]))
  const merged = checked.flatMap((entry) => {
    const before = previous.get(entry.agent)
    // Why: a check that overlapped a finished update may still carry the pre-update version.
    if (before?.run?.state === 'done' && before.current !== entry.current) {
      return [before]
    }
    return before?.run && before.run.state !== 'done' ? [{ ...entry, run: before.run }] : [entry]
  })
  const checkedAgents = new Set(checked.map((entry) => entry.agent))
  const stillRunning = rows.filter(
    (entry) => entry.run?.state === 'running' && !checkedAgents.has(entry.agent)
  )
  return [...merged, ...stillRunning]
}

async function runCheck(settings: AgentUpdateSettings): Promise<AgentUpdatesState> {
  checking = true
  checkedSettingsKey = settingsKey(settings)
  notify()
  try {
    const { rows: checked, sourcesReachable } = await checkAgentUpdates(settings)
    if (sourcesReachable) {
      rows = mergeCheckedRows(checked)
      checkedAt = Date.now()
      retryNotBefore = 0
    } else {
      // Why: an offline check proves nothing; keep the rows and leave checkedAt unset so a retry is allowed after the wait.
      rows = withoutDoneRows(rows)
      retryNotBefore = Date.now() + AGENT_UPDATE_RETRY_AFTER_FAILURE_MS
    }
  } catch {
    // Why: a failed check keeps the previous rows and retries after the wait instead of on every window focus.
    rows = withoutDoneRows(rows)
    retryNotBefore = Date.now() + AGENT_UPDATE_RETRY_AFTER_FAILURE_MS
  } finally {
    checking = false
    inFlightCheck = null
  }
  notify()
  return getAgentUpdatesState()
}

export async function refreshAgentUpdates(
  settings: AgentUpdateSettings
): Promise<AgentUpdatesState> {
  const settingsChanged =
    checkedSettingsKey !== null && checkedSettingsKey !== settingsKey(settings)
  if (inFlightCheck) {
    // Why: the running check read the old settings, so check again once it ends.
    return settingsChanged ? inFlightCheck.then(() => refreshAgentUpdates(settings)) : inFlightCheck
  }
  const now = Date.now()
  const reusable =
    !settingsChanged &&
    ((checkedAt !== null && now - checkedAt < AGENT_UPDATE_CACHE_TTL_MS) || now < retryNotBefore)
  if (reusable) {
    const kept = withoutDoneRows(rows)
    if (kept.length !== rows.length) {
      setRows(kept)
    }
    return getAgentUpdatesState()
  }
  inFlightCheck = runCheck(settings)
  return inFlightCheck
}

function applyOutcome(agent: TuiAgent, outcome: AgentUpdateRunOutcome): void {
  setRows(
    rows.map((entry) => {
      if (entry.agent !== agent) {
        return entry
      }
      if (outcome.status === 'done') {
        return {
          ...entry,
          current: outcome.version,
          updateAvailable: false,
          run: { state: 'done' }
        }
      }
      if (outcome.status === 'failed') {
        return { ...entry, run: { state: 'failed', message: outcome.message } }
      }
      return { ...entry, action: { kind: 'manual', command: outcome.command }, run: null }
    })
  )
}

function dropRows(agents: ReadonlySet<TuiAgent>): void {
  setRows(rows.filter((entry) => !agents.has(entry.agent)))
}

async function runSequentially(
  targets: readonly AgentUpdateRow[],
  getSettings: () => AgentUpdateSettings
): Promise<void> {
  for (const target of targets) {
    // Why: a queued update can start long after the click, so read the settings again.
    const settings = getSettings()
    if (isDisabled(target.agent, settings)) {
      dropRows(new Set([target.agent]))
      continue
    }
    let outcome: AgentUpdateRunOutcome
    try {
      outcome = await runAgentUpdate(target.agent, target.current, settings)
    } catch (error) {
      // Why: an unexpected rejection must end this row as failed, not leave it running.
      outcome = {
        status: 'failed',
        message: error instanceof Error ? error.message : String(error)
      }
    }
    applyOutcome(target.agent, outcome)
  }
}

/** Marks every requested row running at once, then updates them one at a time. */
export async function startAgentUpdates(
  agents: readonly TuiAgent[],
  getSettings: () => AgentUpdateSettings
): Promise<void> {
  const requested = new Set(agents)
  const settings = getSettings()
  const disabled = new Set([...requested].filter((agent) => isDisabled(agent, settings)))
  if (disabled.size > 0) {
    dropRows(disabled)
  }
  const targets = rows.filter(
    (entry) => requested.has(entry.agent) && entry.run?.state !== 'running'
  )
  if (targets.length === 0) {
    return
  }
  const targetAgents = new Set(targets.map((entry) => entry.agent))
  setRows(
    rows.map((entry) =>
      targetAgents.has(entry.agent) ? { ...entry, run: { state: 'running' } } : entry
    )
  )
  // Why: second line of defence; a rejected queue would block every later run.
  runQueue = runQueue
    .then(() => runSequentially(targets, getSettings))
    .catch((error) => console.error('[agent-updates] update run failed', error))
  await runQueue
}
