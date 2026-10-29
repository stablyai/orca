import type { AgentSessionDispatchOutcome } from './structured-agent-session-adapter'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import type { AgentChatPermissionChoice } from '../../../shared/agent-chat-permission-mode'

export type StructuredAgentSessionInputAdmission =
  | { kind: 'prepare' }
  | { kind: 'acquire' }
  | { kind: 'sent'; response: Promise<unknown> }

/** The synchronous writer runs under host ordering; its response is awaited outside it. */
export type StructuredAgentSessionAdmitFreshInput = (
  enqueue: (
    mode: AgentChatPermissionChoice,
    inheritRunning: boolean,
    body?: AgentJournalMessageItem
  ) => StructuredAgentSessionInputAdmission,
  signal?: AbortSignal
) => Promise<StructuredAgentSessionInputAdmission>

export type StructuredAgentSessionAdmitHostInput = (
  enqueue: Parameters<StructuredAgentSessionAdmitFreshInput>[0],
  signal: AbortSignal | undefined,
  prepare: (fence: number) => Promise<AgentJournalMessageItem>
) => ReturnType<StructuredAgentSessionAdmitFreshInput>

export type StructuredAgentSessionContinueInput = (
  signal: AbortSignal | undefined,
  rebind: (fence: number) => Promise<void>
) => Promise<
  | { kind: 'ready'; isCurrent: () => boolean }
  | { kind: 'failed'; fence: number; outcome: AgentSessionDispatchOutcome }
>

/** Host-local control, never a provider failure or a replay of a possibly written request. */
export class StructuredAgentSessionInputNotAdmitted extends Error {
  constructor(readonly outcome?: Extract<AgentSessionDispatchOutcome, { state: 'rejected' }>) {
    super('input was not admitted')
  }
}
