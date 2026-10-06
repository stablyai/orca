/**
 * A terminal `--resume` must not land on a conversation a structured chat still writes.
 *
 * The record store is the only durable proof of which provider conversation a chat holds. Resuming
 * that same conversation in a terminal would put two writers on it, which Codex permits silently
 * and Claude answers by corrupting the thread.
 */

import type { RuntimeEnsureAgentSessionRequest } from '../../../../shared/agent-session-host-authority'
import { agentSessionLeaseOwnerVerdict } from '../../../../shared/agent-session-lease-adjudication'
import type { AgentSessionRecord } from '../../../../shared/agent-session-record'
import {
  agentSessionProviderHandleChainHead,
  agentSessionProviderHandleRoot,
  isAgentSessionHandleProvider,
  type AgentSessionProviderHandle
} from '../../../../shared/agent-session-provider-handle'
import { agentSessionRefusalError } from '../../../../shared/agent-session-wire-refusals'

// Both terminal resume and structured adoption run in the main process.  Keep
// their effect windows serialized by provider conversation root.  The durable
// record transaction remains the authority for structured-vs-structured races;
// this gate only closes the cross-lane window.
const conversationGates = new Map<string, Promise<void>>()

export function agentSessionConversationRoot(
  request: RuntimeEnsureAgentSessionRequest
): string | null {
  return explicitResumeConversationRoot(request)
}

export async function withAgentSessionConversationGate<T>(
  root: string | null,
  run: () => Promise<T>
): Promise<T> {
  if (root === null) {
    return await run()
  }
  const previous = conversationGates.get(root) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  conversationGates.set(root, current)
  await previous
  try {
    return await run()
  } finally {
    release()
    if (conversationGates.get(root) === current) {
      conversationGates.delete(root)
    }
  }
}

/** The store read this guard needs; the host's own record store satisfies it. */
export type StructuredRecordReader = {
  listRecords(): readonly AgentSessionRecord[]
}

/** Just enough of the structured host to enumerate its records. Null means none exist in this
 *  process, so nothing can be holding the conversation. */
export type StructuredRecordHost = {
  readonly deps: { readonly store: StructuredRecordReader }
}

/** The conversation an explicit resume names, keyed as a record's handle chain keys it. Null for an
 *  agent with no structured lane, which no record can hold. */
function explicitResumeConversationRoot(request: RuntimeEnsureAgentSessionRequest): string | null {
  if (request.kind !== 'explicit' || !isAgentSessionHandleProvider(request.agent)) {
    return null
  }
  const handle: AgentSessionProviderHandle = {
    transport: request.agent === 'claude' ? 'claude-sdk' : 'codex-app-server',
    agent: request.agent,
    nativeId: request.providerSession.id
  }
  return agentSessionProviderHandleRoot(handle)
}

/** The head only: a record that forked off this conversation no longer writes it, and its chain
 *  keeps the root only as provenance. */
function recordHoldsConversation(record: AgentSessionRecord, root: string): boolean {
  const head = agentSessionProviderHandleChainHead(record.providerHandleChain)
  return head !== null && agentSessionProviderHandleRoot(head.handle) === root
}

export function assertExplicitResumeConversationUnowned(
  request: RuntimeEnsureAgentSessionRequest,
  host: StructuredRecordHost | null
): void {
  const root = explicitResumeConversationRoot(request)
  if (root === null || host === null) {
    return
  }
  const held = host.deps.store
    .listRecords()
    .filter((record) => recordHoldsConversation(record, root))
  // No holder (the common case) passes, as does every holder proven exited; a live or unverifiable
  // owner is refused, because loss of contact is never evidence of process death.
  if (held.every((record) => agentSessionLeaseOwnerVerdict(record.lease) === 'exited')) {
    return
  }
  throw agentSessionRefusalError('agent_session_conflict', { reason: 'conversationHeldElsewhere' })
}
