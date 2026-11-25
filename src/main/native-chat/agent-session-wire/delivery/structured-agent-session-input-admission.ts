import { agentSessionFailureFact } from '../../../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../../../shared/agent-session/failures/agent-session-failure-words'
import type { AgentSessionDispatchOutcome } from '../providers/structured-agent-session-adapter'
import type { AgentJournalMessageItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentChatPermissionChoice } from '../../../../shared/agent-launch/permissions/agent-chat-permission-mode'

/** Why an unwritten input needs a new child: its permission mode, or tools changed since launch. */
export type StructuredAgentSessionAcquireReason = 'permission' | 'auto' | 'tools'

export type StructuredAgentSessionInputAdmission =
  | { kind: 'prepare' }
  | { kind: 'acquire'; reason?: StructuredAgentSessionAcquireReason }
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
  reason?: StructuredAgentSessionAcquireReason
) => Promise<
  | { kind: 'ready'; isCurrent: () => boolean }
  | { kind: 'failed'; fence: number; outcome: AgentSessionDispatchOutcome }
>

/** Host-local control, never a provider failure or a replay of a possibly written request. */
export class StructuredAgentSessionInputNotAdmitted extends Error {
  constructor(
    readonly outcome?: Extract<AgentSessionDispatchOutcome, { state: 'rejected' }>,
    readonly reason: StructuredAgentSessionAcquireReason = 'auto'
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

/** Non-delivery proof applies only to queued handoffs; direct sends still owe stopped-history handling. */
export function cancelledDispatch(
  neverReachedAgent: boolean
): Extract<AgentSessionDispatchOutcome, { state: 'rejected' }> {
  return {
    state: 'rejected',
    ...agentSessionFailureWords(
      agentSessionFailureFact('cancelled', neverReachedAgent ? { neverReachedAgent } : {}),
      { surface: 'rejection' }
    )
  }
}
