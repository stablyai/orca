/** Enumerate structured group recipients separately: terminal.list is a paired-client wire shape with PTY/writability assumptions. */

import type { TerminalAgent } from '../../../shared/terminal-agent'
import {
  holdStructuredWorker,
  resolveStructuredWorkerAuthority,
  structuredWorkerAgent
} from '../structured-worker-authority'
import {
  STRUCTURED_WORKER_INCARNATION_PREFIX,
  structuredWorkerIdentityFromRow
} from '../structured-worker-identity'
import type { OrchestrationDb } from './db'
import { readStructuredSessionGateFacts } from './structured-mailbox-pointer-host'
import type { RunningStructuredSession } from './structured-session-lineage'

/** The only facts group addressing reads off a recipient. */
export type OrchestrationAddressableAgent = {
  handle: string
  worktreeId: string
  /** Absent means "unknown", and `@claude`/`@codex` fail closed on it, exactly as for a pane. */
  agentIdentity?: TerminalAgent
}

/** Use durable ownership, not current process liveness; mail can restart an idle held worker, but not a retired one. */
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
      return holdStructuredWorker(identity, db, row).kind === 'held' ? [identity] : []
    })
    .map((identity) => ({
      handle: identity.handle,
      worktreeId: identity.worktreeId,
      agentIdentity: structuredWorkerAgent(identity)
    }))
}

/** Read a held structured worker's live session; undefined delegates non-structured handles to PTY probes. */
export async function structuredWorkerHandleAgentStatus(
  handle: string,
  db: OrchestrationDb | null | undefined
): Promise<string | null | undefined> {
  const authority = resolveStructuredWorkerAuthority(handle, db)
  return authority ? structuredWorkerAgentStatus(authority.running) : undefined
}

/** Unknown session status must not become idle and interrupt a busy worker through @idle. */
export async function structuredWorkerAgentStatus(
  running: RunningStructuredSession
): Promise<string | null> {
  const facts = await readStructuredSessionGateFacts(running.sessionId)
  if (!facts) {
    return null
  }
  if (facts.awaitingHuman) {
    return 'attention'
  }
  return facts.turnRunning ? 'working' : 'idle'
}
