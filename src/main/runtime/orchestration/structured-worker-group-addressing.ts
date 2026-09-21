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
import { observeStructuredWorker, structuredWorkerAgent } from '../structured-worker-authority'
import { structuredWorkerIdentities } from '../structured-worker-identity'
import { readStructuredSessionGateFacts } from './structured-mailbox-pointer-host'

/** The only facts group addressing reads off a recipient. */
export type OrchestrationAddressableAgent = {
  handle: string
  worktreeId: string
  /** Absent means "unknown", and `@claude`/`@codex` fail closed on it, exactly as for a pane. */
  agentIdentity?: TuiAgent
}

/**
 * Live structured workers of this runtime, as group-address candidates.
 *
 * Liveness-gated on the same observation the rest of the structured surface uses: a settled or
 * handed-off worker is not a recipient, and addressing one would store mail no lane will deliver.
 */
export function listAddressableStructuredWorkers(): OrchestrationAddressableAgent[] {
  return structuredWorkerIdentities
    .list()
    .filter((identity) => observeStructuredWorker(identity).status === 'live')
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
 * would wake a worker mid-turn — which Codex answers with `turn already running` and Claude queues
 * behind the running turn.
 */
export function structuredWorkerAgentStatus(sessionId: string): string | null {
  const facts = readStructuredSessionGateFacts(sessionId)
  if (!facts) {
    return null
  }
  if (facts.awaitingHuman) {
    return 'attention'
  }
  return facts.turnRunning ? 'working' : 'idle'
}
