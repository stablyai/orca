// What the wire needs from a provider adapter.
//
// Phase 2 implements this over the Codex app-server and the Claude Agent SDK;
// nothing here starts, resumes, or talks to a process. The wire owns the
// journal and the lease, so an adapter only has to answer "did the provider
// take this?" — and it answers `unknown` rather than guessing, because the
// journal renders that as delivery unconfirmed instead of as failure.

import type {
  AgentJournalItemIdentity,
  AgentJournalMessageItem,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import type { AgentSessionProviderHandleLink } from '../../../shared/agent-session-provider-handle'
import type {
  AgentSessionExecutionLocation,
  AgentSessionProcessIdentity
} from '../../../shared/agent-session-record'
import type {
  AgentSessionEffectAuthority,
  AgentSessionOptionsResult
} from '../../../shared/agent-session-wire'
import type { StructuredAgentSessionEventSink } from './structured-agent-session-event-sink'

/** What a reservation turns into once something is actually running under it:
 *  the process the host can probe, and the provider handle it was minted with. */
export type AgentSessionAcquisition = {
  process: AgentSessionProcessIdentity
  link: AgentSessionProviderHandleLink
}

/** Acquisition validation failed before the adapter attempted to spawn. */
export class AgentSessionPreSpawnError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
    this.name = 'AgentSessionPreSpawnError'
  }
}

export function isAgentSessionPreSpawnError(error: unknown): error is AgentSessionPreSpawnError {
  return error instanceof Error && error.name === 'AgentSessionPreSpawnError'
}

export type AgentSessionDispatchOutcome =
  /** The provider owns the turn now, under this identity. */
  | { state: 'accepted'; providerIdentity: AgentJournalItemIdentity }
  | { state: 'rejected'; reason: string }
  /** The call did not settle. Never re-send on the user's behalf. */
  | { state: 'unknown'; reason: string }

export type StructuredAgentSessionAcquireInput = {
  identity: AgentSessionJournalIdentity
  fence: number
  spawnToken: string
  options?: Readonly<Record<string, string>>
  /** Provider events may begin before acquisition returns. */
  events?: StructuredAgentSessionEventSink
}

export type StructuredAgentSessionSetOptionInput = {
  sessionId: string
  key: string
  value: string
  fence: number
}

export type StructuredAgentSessionAdapter = {
  /** Provider/runtime support, kept here so remote enablement changes adapter data, not UI logic. */
  supportsLocation?(location: AgentSessionExecutionLocation): boolean
  /** Makes the reservation real. Called once per reservation, with the spawn
   *  token the lease was reserved under and the fence the handle must be minted
   *  at — the store rejects a link minted at any other fence. */
  acquire(input: StructuredAgentSessionAcquireInput): Promise<AgentSessionAcquisition>
  /** Reaps an acquired provider when the host cannot commit or prove its lease. */
  releaseAcquisition?(input: { sessionId: string }): Promise<void>
  dispatch(input: {
    sessionId: string
    clientMessageId: string
    body: AgentJournalMessageItem
    fence: number
    requestAuthority?: {
      effectAuthority: AgentSessionEffectAuthority
      requestReceiptId: string
    }
  }): Promise<AgentSessionDispatchOutcome>
  /** A host-authenticated local user turn supersedes mutation authority globally. */
  invalidateEffectAuthorityForTrustedUserTurn?(input: { sourceSessionId: string }): Promise<void>
  /** Cancels one turn, not the session: a session-wide interrupt would also kill
   *  a turn the client never asked to stop. */
  cancelTurn(input: {
    sessionId: string
    turnId: string
    fence: number
  }): Promise<{ cancelled: boolean }>
  /** Fires the provider callback for an approval or a question. The wire calls
   *  this only after the durable compare-and-set won, so it runs exactly once. */
  answerPrompt(input: {
    sessionId: string
    itemId: string
    kind: 'approval' | 'question'
    optionId: string
    fence: number
  }): Promise<void>
  setOption(
    input: StructuredAgentSessionSetOptionInput
  ): Promise<void | Readonly<Record<string, string>>>
  readOptions?(input: { sessionId: string; fence: number }): Promise<AgentSessionOptionsResult>
  /** Transcript path for journal recovery. Omit to let the existing session-file
   *  resolver discover it from the provider session id. */
  historyFilePath?(input: { identity: AgentSessionJournalIdentity }): Promise<string | null>
  /** Gracefully stops the structured owner after its event stream is drained. */
  closeSession?(sessionId: string): Promise<void>
}
