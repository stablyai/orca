import type { AgentSessionDispatchOutcome } from './structured-agent-session-adapter'
import type { AgentJournalMessageItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentChatPermissionChoice } from '../../../shared/agent-chat-permission-mode'

export type StructuredAgentSessionInputAdmission =
  | { kind: 'prepare' }
  | { kind: 'acquire'; reason?: 'permission' | 'auto' }
  | { kind: 'sent'; response: Promise<unknown> }

/** The synchronous writer runs under host ordering; its response is awaited outside it. */
export type StructuredAgentSessionAdmitFreshInput = (
  enqueue: (
    mode: AgentChatPermissionChoice,
    inheritRunning: boolean,
    body?: AgentJournalMessageItem
  ) => StructuredAgentSessionInputAdmission,
  signal?: AbortSignal,
  kind?: 'fresh' | 'steer'
) => Promise<StructuredAgentSessionInputAdmission>

export type StructuredAgentSessionAdmitHostInput = (
  enqueue: Parameters<StructuredAgentSessionAdmitFreshInput>[0],
  signal: AbortSignal | undefined,
  prepare: (fence: number) => Promise<AgentJournalMessageItem>,
  kind?: 'fresh' | 'steer'
) => ReturnType<StructuredAgentSessionAdmitFreshInput>

export type StructuredAgentSessionContinueInput = (
  signal: AbortSignal | undefined,
  rebind: (fence: number) => Promise<void>,
  reason?: 'permission' | 'auto'
) => Promise<
  | { kind: 'ready'; isCurrent: () => boolean }
  | { kind: 'failed'; fence: number; outcome: AgentSessionDispatchOutcome }
>

/** Host-local control, never a provider failure or a replay of a possibly written request. */
export class StructuredAgentSessionInputNotAdmitted extends Error {
  constructor(
    readonly outcome?: Extract<AgentSessionDispatchOutcome, { state: 'rejected' }>,
    readonly reason: 'permission' | 'auto' = 'auto'
  ) {
    super('input was not admitted')
  }
}

/** Commit provider ownership in the same ordered step that checks the saved choice. */
export async function admitStructuredAgentSessionInput(
  admit: StructuredAgentSessionAdmitFreshInput | undefined,
  commit: () => void
): Promise<void> {
  if (!admit) {
    commit()
    return
  }
  const result = await admit(
    () => {
      commit()
      return { kind: 'sent', response: Promise.resolve() }
    },
    undefined,
    'steer'
  )
  if (result.kind !== 'sent') {
    throw new StructuredAgentSessionInputNotAdmitted(
      undefined,
      result.kind === 'acquire' ? result.reason : 'permission'
    )
  }
  await result.response
}
