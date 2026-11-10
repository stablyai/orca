import type { TuiAgent } from '../../shared/agent-launch/catalog/tui-agent'
import type {
  AgentUpdateRow,
  AgentUpdatesState
} from '../../shared/agent-updates/agent-update-types'
import { checkAgentUpdates, type AgentUpdateSettings } from './check-agent-updates'
import { runAgentUpdate, type AgentUpdateRunOutcome } from './run-agent-update'

/** A refresh inside this window reuses the last check instead of probing every agent again. */
const AGENT_UPDATE_CACHE_TTL_MS = 4 * 60 * 60 * 1000

type AgentUpdatesListener = (state: AgentUpdatesState) => void

let rows: AgentUpdateRow[] = []
let checking = false
let checkedAt: number | null = null
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
  const merged = checked.map((entry) => {
    const run = previous.get(entry.agent)?.run
    return run && run.state !== 'done' ? { ...entry, run } : entry
  })
  const checkedAgents = new Set(checked.map((entry) => entry.agent))
  const stillRunning = rows.filter(
    (entry) => entry.run?.state === 'running' && !checkedAgents.has(entry.agent)
  )
  return [...merged, ...stillRunning]
}

async function runCheck(settings: AgentUpdateSettings): Promise<AgentUpdatesState> {
  checking = true
  notify()
  try {
    const { rows: checked, sourcesReachable } = await checkAgentUpdates(settings)
    if (sourcesReachable) {
      rows = mergeCheckedRows(checked)
      checkedAt = Date.now()
    } else {
      // Why: an offline check proves nothing; keep the rows and leave checkedAt so the next refresh retries.
      rows = withoutDoneRows(rows)
    }
  } catch {
    // Why: a failed check keeps the previous rows; the next refresh retries because checkedAt is unchanged.
    rows = withoutDoneRows(rows)
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
  if (inFlightCheck) {
    return inFlightCheck
  }
  if (checkedAt !== null && Date.now() - checkedAt < AGENT_UPDATE_CACHE_TTL_MS) {
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

async function runSequentially(
  targets: readonly AgentUpdateRow[],
  settings: AgentUpdateSettings
): Promise<void> {
  for (const target of targets) {
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
  settings: AgentUpdateSettings
): Promise<void> {
  const requested = new Set(agents)
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
    .then(() => runSequentially(targets, settings))
    .catch((error) => console.error('[agent-updates] update run failed', error))
  await runQueue
}
