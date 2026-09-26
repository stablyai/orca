/**
 * Structured workers as group-address recipients.
 *
 * `@all` and its siblings resolve recipients from `listTerminals`, which enumerates leaves and
 * PTYs — so a structured worker was never a candidate. Worse, the exclusion happened BEFORE
 * per-recipient resolution, so the `SendRecipientWarning` machinery never ran and the caller got
 * exit 0 plus a receipt naming only the workers that did resolve. A broadcast "stop work" reached
 * the PTY workers and silently missed the structured ones.
 *
 * Deliberately NOT solved by teaching `listTerminals` about structured sessions: that result is
 * published to paired mobile and remote clients and to every consumer that assumes a summary has a
 * `ptyId` or is writable, so it is its own change under
 * `docs/reference/remote-wire-compatibility.md`. Group addressing needs three fields, and
 * `RuntimeTerminalSummary` already satisfies them structurally — so the group resolver widens to
 * the smaller shape instead, and nothing here has to invent a `worktreePath` or a `branch`.
 */

import type { TuiAgent } from '../../../shared/tui-agent'
import {
  structuredWorkerAgent,
  structuredWorkerOwned,
  structuredWorkerResourceReleased
} from '../structured-worker-authority'
import {
  STRUCTURED_WORKER_INCARNATION_PREFIX,
  structuredWorkerIdentityFromRow
} from '../structured-worker-identity'
import type { OrchestrationDb } from './db'
import { readStructuredSessionGateFacts } from './structured-mailbox-pointer-host'

/** The only facts group addressing reads off a recipient. */
export type OrchestrationAddressableAgent = {
  handle: string
  worktreeId: string
  /** Absent means "unknown", and `@claude`/`@codex` fail closed on it, exactly as for a pane. */
  agentIdentity?: TuiAgent
}

/**
 * Structured workers this runtime owns, as group-address candidates.
 *
 * Read from the durable worker-terminal rows, which outlive a settled dispatch and a restart, and
 * gated on ownership and on the orchestration not having released it — the same answer direct mail
 * routes on — never on liveness: a worker at rest is a recipient, and the mail starts it. A retired
 * or released one is not.
 */
export function listAddressableStructuredWorkers(
  db: OrchestrationDb | null
): OrchestrationAddressableAgent[] {
  const seen = new Set<string>()
  return (
    db?.listWorkerTerminalResourcesByIncarnationPrefix(STRUCTURED_WORKER_INCARNATION_PREFIX) ?? []
  )
    .flatMap((row) => {
      const identity = structuredWorkerIdentityFromRow(row)
      // Newest row first: a session is one recipient, under its latest handle.
      if (!identity || seen.has(identity.sessionId)) {
        return []
      }
      seen.add(identity.sessionId)
      return structuredWorkerOwned(identity.sessionId) === true &&
        !structuredWorkerResourceReleased(row)
        ? [identity]
        : []
    })
    .map((identity) => ({
      handle: identity.handle,
      worktreeId: identity.worktreeId,
      agentIdentity: structuredWorkerAgent(identity) as TuiAgent
    }))
}

/**
 * A structured worker's agent status, in the vocabulary `@idle` already matches on.
 *
 * Null when the session cannot be read: unknown must not read as idle, or a broadcast to `@idle`
 * would wake a worker mid-turn — which Codex coalesces into the running turn and Claude queues
 * behind it.
 */
export async function structuredWorkerAgentStatus(sessionId: string): Promise<string | null> {
  const facts = await readStructuredSessionGateFacts(sessionId)
  if (!facts) {
    return null
  }
  if (facts.awaitingHuman) {
    return 'attention'
  }
  return facts.turnRunning ? 'working' : 'idle'
}
