import type { RuntimeAgentOrchestrationDependencies } from './runtime-agent-orchestration-projection'
import type { AgentSenderHandleReads, AgentSenderLivePanes } from './runtime-agent-sender-panes'
import type { AgentSenderPrincipal } from './runtime-agent-sender-history'
import type { OrchestrationDb } from './orchestration/db'
import { readAgentSenderGeneration } from './runtime-agent-sender-history-triggers'

export function sameAgentSenderInput(key: unknown[], other: unknown[]): boolean {
  return key.length === other.length && key.every((value, i) => value === other[i])
}

export type AgentSenderDependencies = Omit<
  RuntimeAgentOrchestrationDependencies,
  'issueLeafHandle' | 'issuePtyHandle'
> &
  AgentSenderHandleReads & {
    peerFingerprint(): string | undefined
    /** This host's principal as the paired environment authenticates it, and that peer's key. */
    principal(environmentId: string): AgentSenderPrincipal | undefined
    /** Moves when a pairing changes, so principals are read again only then. */
    pairingGeneration(): number
  }
export function captureAgentSenderInput(
  deps: AgentSenderDependencies,
  panesOwner: AgentSenderLivePanes,
  database: OrchestrationDb | null
) {
  const db = deps.getDb()
  const install = db !== database
  const generation = db ? readAgentSenderGeneration(db, install) : null
  const panes = panesOwner.read()
  const peerFingerprint = deps.peerFingerprint()
  // Primitives compared in place: a status-only build allocates no key string.
  const terminalKey: unknown[] = [
    generation?.history,
    generation?.principals,
    deps.pairingGeneration(),
    peerFingerprint
  ]
  for (const p of panes.values()) {
    terminalKey.push(p.paneKey, p.worktreeId, p.handle, p.processIncarnation, p.original)
  }
  const records = deps.getSessionRecords()
  // A store says when what chats read changed; a reader without it is listed.
  const chatKey = [
    records?.listRecords,
    records?.senderIdentityRevision
      ? records.senderIdentityRevision()
      : JSON.stringify([
          records?.listRecords().map((r) => [r.sessionId, r.location, r.conversationCommand]),
          records?.getVisibleSessionTabIndex?.()
        ])
  ]
  return { db, install, generation, panes, peerFingerprint, terminalKey, records, chatKey }
}
