import { useSyncExternalStore } from 'react'
import {
  AGENT_CLI_UPDATE_AGENTS,
  type AgentCliUpdateAgent,
  type AgentCliUpdateRunResult
} from '../../../../../src/shared/agent-launch/installation/agent-cli-update'
import {
  AGENT_CLI_UPDATE_CHECK_TIMEOUT_MS,
  AGENT_CLI_UPDATE_RUN_TIMEOUT_MS,
  AGENT_CLI_UPDATES_AT_ONCE,
  agentCliUpdateRunAfter,
  callAgentCliUpdateRun,
  sameAgentCliUpdates,
  type AgentCliUpdateHost,
  type AgentCliUpdateRun,
  type AgentCliUpdateRunAnswer
} from '../../../../../src/shared/agent-launch/installation/agent-cli-update-runs'
import { PrioritySemaphore } from '../../../../../src/shared/concurrency/priority-semaphore'
import type { RpcClient } from '../../../transport/rpc/rpc-client-contract'
import { agentCliUpdateRun, agentCliUpdatesCheck } from './agent-cli-update-operations'

/** A computer's CLIs as Edit computer shows them; `done` keeps "Updated to" rows until the screen opens again. */
export type HostAgentCliUpdates = AgentCliUpdateHost & {
  done: Partial<Record<AgentCliUpdateAgent, string>>
}

// Reopening Edit computer soon after reuses the answer; the host reads up to 17 CLI versions per check.
const CHECK_REUSE_MS = 10_000
const EMPTY: HostAgentCliUpdates = { updates: [], runs: {}, done: {} }

/** Everything kept for one computer. Async work holds its entry, so a removed computer's late answers land nowhere. */
type HostEntry = {
  state: HostAgentCliUpdates
  check: Promise<void> | null
  checkedAt: number
  slots: PrioritySemaphore
  /** The failed rows of runs whose answer never arrived (a dropped connection), until a check reads them. */
  unanswered: Map<AgentCliUpdateAgent, AgentCliUpdateRun>
  /** When each agent's update last landed, so a check sent before it can't offer it again. */
  updatedAt: Map<AgentCliUpdateAgent, number>
}

// Kept per paired computer while the app runs, so leaving Edit computer never orphans a run.
const entries = new Map<string, HostEntry>()
const listeners = new Set<() => void>()

function entryFor(hostId: string): HostEntry {
  let entry = entries.get(hostId)
  if (!entry) {
    entry = {
      state: EMPTY,
      check: null,
      checkedAt: 0,
      slots: new PrioritySemaphore(AGENT_CLI_UPDATES_AT_ONCE),
      unanswered: new Map(),
      updatedAt: new Map()
    }
    entries.set(hostId, entry)
  }
  return entry
}

function write(
  hostId: string,
  entry: HostEntry,
  next: (host: HostAgentCliUpdates) => HostAgentCliUpdates
): void {
  if (entries.get(hostId) !== entry) {
    return
  }
  const updated = next(entry.state)
  if (updated !== entry.state) {
    entry.state = updated
    listeners.forEach((listener) => listener())
  }
}

function writeRun(
  hostId: string,
  entry: HostEntry,
  agent: AgentCliUpdateAgent,
  run: AgentCliUpdateRun
): void {
  write(hostId, entry, (host) => ({ ...host, runs: { ...host.runs, [agent]: run } }))
}

const busy = (run: AgentCliUpdateRun | undefined): boolean =>
  run?.phase === 'queued' || run?.phase === 'running'

/** Asks the computer which of the user's own CLIs are behind; a check still on its way is shared. */
export function checkHostAgentCliUpdates(
  hostId: string,
  client: RpcClient,
  options: { force?: boolean } = {}
): Promise<void> {
  return checkEntry(hostId, entryFor(hostId), client, options.force === true)
}

function checkEntry(
  hostId: string,
  entry: HostEntry,
  client: RpcClient,
  force: boolean
): Promise<void> {
  // A computer removed meanwhile is not asked again, and never comes back into the store.
  if (entries.get(hostId) !== entry) {
    return Promise.resolve()
  }
  if (entry.check) {
    // A forced check must be asked after whatever made it necessary, not answered by an older one.
    return force ? entry.check.then(() => checkEntry(hostId, entry, client, true)) : entry.check
  }
  if (!force && Date.now() - entry.checkedAt < CHECK_REUSE_MS) {
    return Promise.resolve()
  }
  const sentAt = Date.now()
  entry.checkedAt = sentAt
  // Only runs already unanswered when this check is sent can be read from its reply.
  const lost = [...entry.unanswered]
  const check = agentCliUpdatesCheck
    .request(
      client,
      { agents: [...AGENT_CLI_UPDATE_AGENTS] },
      { timeoutMs: AGENT_CLI_UPDATE_CHECK_TIMEOUT_MS }
    )
    .then((reply) => {
      // An update that landed after this check was sent is newer than the check's answer.
      const updates = agentCliUpdatesCheck
        .interpret(reply)
        .filter((update) => (entry.updatedAt.get(update.agent) ?? 0) <= sentAt)
      for (const [agent, row] of lost) {
        if (entry.unanswered.get(agent) === row) {
          entry.unanswered.delete(agent)
        }
      }
      write(hostId, entry, (host) => {
        // A run whose answer was lost is unknown, not failed: once the computer no longer offers that
        // update the row goes (its CLI may have updated, or no longer reads), never claiming success.
        // Only that run's own row goes; a retry's failure since then is the host's real answer.
        const runs = { ...host.runs }
        for (const [agent, row] of lost) {
          if (runs[agent] === row && !updates.some((u) => u.agent === agent)) {
            delete runs[agent]
          }
        }
        const runsChanged = Object.keys(runs).length !== Object.keys(host.runs).length
        if (!runsChanged && sameAgentCliUpdates(host.updates, updates)) {
          return host
        }
        return { ...host, updates, runs }
      })
    })
    .catch(() => {
      // A failed check must not hold off the next one.
      entry.checkedAt = 0
    })
    .finally(() => {
      entry.check = null
    })
  entry.check = check
  return check
}

/** Records a run's answer; returns the failed row it wrote, or null when the update landed. */
function settleRun(
  hostId: string,
  entry: HostEntry,
  agent: AgentCliUpdateAgent,
  result: AgentCliUpdateRunResult
): AgentCliUpdateRun | null {
  const failed = agentCliUpdateRunAfter(result, Date.now())
  if (failed) {
    writeRun(hostId, entry, agent, failed)
    return failed
  }
  entry.updatedAt.set(agent, Date.now())
  write(hostId, entry, (host) => {
    const runs = { ...host.runs }
    delete runs[agent]
    const latest = host.updates.find((u) => u.agent === agent)?.latestVersion ?? ''
    return {
      updates: host.updates.filter((u) => u.agent !== agent),
      runs,
      done: { ...host.done, [agent]: latest }
    }
  })
  return null
}

/** Runs one CLI's update on the computer, at most a few at a time; a second tap while queued does nothing. */
export async function runHostAgentCliUpdate(
  hostId: string,
  client: RpcClient,
  agent: AgentCliUpdateAgent
): Promise<void> {
  const entry = entryFor(hostId)
  if (busy(entry.state.runs[agent])) {
    return
  }
  writeRun(hostId, entry, agent, { phase: 'queued' })
  const release = await entry.slots.acquire(0)
  writeRun(hostId, entry, agent, { phase: 'running' })
  const { result, late, answered } = await callAgentCliUpdateRun(() =>
    agentCliUpdateRun
      .request(client, { agent }, { timeoutMs: AGENT_CLI_UPDATE_RUN_TIMEOUT_MS })
      .then((reply) => agentCliUpdateRun.interpret(reply))
  ).finally(release)
  const settled = settleRun(hostId, entry, agent, result)
  if (late && settled) {
    // The ceiling only means the answer is late: a check can already read the CLI, and a later
    // answer from the host still decides the row unless something replaced it.
    markUnanswered(hostId, entry, client, agent, settled)
    void late.then((answer) => {
      if (entry.state.runs[agent] === settled) {
        settleAnswer(hostId, entry, client, agent, answer)
      }
    })
  } else if (!answered && settled) {
    markUnanswered(hostId, entry, client, agent, settled)
  }
}

function settleAnswer(
  hostId: string,
  entry: HostEntry,
  client: RpcClient,
  agent: AgentCliUpdateAgent,
  answer: AgentCliUpdateRunAnswer
): void {
  if (answer.answered) {
    settleRun(hostId, entry, agent, answer.result)
    return
  }
  const row = entry.state.runs[agent]
  if (row) {
    markUnanswered(hostId, entry, client, agent, row)
  }
}

/** The host joins a run already going, so the check after a reconnect reads it once finished. */
function markUnanswered(
  hostId: string,
  entry: HostEntry,
  client: RpcClient,
  agent: AgentCliUpdateAgent,
  row: AgentCliUpdateRun
): void {
  entry.unanswered.set(agent, row)
  void checkEntry(hostId, entry, client, true)
}

/** Forgets a removed computer; a run still going settles into nothing. */
export function forgetHostAgentCliUpdates(hostId: string): void {
  if (entries.delete(hostId)) {
    listeners.forEach((listener) => listener())
  }
}

/** Drops last visit's "Updated to" rows, as the screen opens again. */
export function forgetDoneHostAgentCliUpdates(hostId: string): void {
  const entry = entries.get(hostId)
  if (entry) {
    write(hostId, entry, (host) =>
      Object.keys(host.done).length === 0 ? host : { ...host, done: {} }
    )
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useHostAgentCliUpdates(hostId: string): HostAgentCliUpdates {
  const read = (): HostAgentCliUpdates => entries.get(hostId)?.state ?? EMPTY
  return useSyncExternalStore(subscribe, read, read)
}
