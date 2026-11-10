import type { AgentJournalMessageItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionSendResult } from '../../../../shared/agent-session/agent-session-wire'
import {
  USER_MESSAGE_SOURCE,
  AGENT_MESSAGE_SOURCE
} from '../../../../shared/agent-session/agent-session-message-source'
import { agentSessionSendBodyFingerprint } from '../../../../shared/agent-session/requests/structured-agent-session-send-mutation'
import { copyJournalCurrentWorkAuthority } from '../../agent-session-journal/journal-observer-read'
import type { JournalSendAdmissionResult } from '../../agent-session-journal/journal-send-admission'
import { captureHostStructuredAgentSessionWork } from '../observations/structured-agent-session-read-work'
import type { StructuredAgentSessionMutationContext } from '../operations/structured-agent-session-mutation-context'
import {
  type AgentSessionTurnContext,
  type TurnOutcome,
  agentSessionAdmissionWriteRefusal
} from '../operations/structured-agent-session-turns'
import { captureStructuredExecutionOptions } from '../options/structured-agent-session-execution-options'

export type StructuredSendAdmissionParams = {
  envelope: { clientOperationId: string }
  body: AgentJournalMessageItem
  delivery?: 'queue-if-active'
  queuedImageCards?: boolean
  options?: Readonly<Record<string, string>>
  selection?: Readonly<Record<string, string>>
  userSend?: true
  personsMessage?: true
  usageLimitContinuationOfTurnItemId?: string
}

type SendContext = Pick<
  AgentSessionTurnContext,
  | 'sessionId'
  | 'logger'
  | 'journal'
  | 'fence'
  | 'operationReceipt'
  | 'agents'
  | 'agent'
  | 'persistedOptions'
>

/** Capture only live host authority; the writer decides and persists queue or immediate admission. */
export async function admitStructuredAgentSessionSend(
  context: StructuredAgentSessionMutationContext,
  ctx: SendContext,
  params: StructuredSendAdmissionParams,
  queueOnly?: false
): Promise<TurnOutcome<AgentSessionSendResult>>
export async function admitStructuredAgentSessionSend(
  context: StructuredAgentSessionMutationContext,
  ctx: SendContext,
  params: StructuredSendAdmissionParams,
  queueOnly: true
): Promise<TurnOutcome<AgentSessionSendResult> | null>
export async function admitStructuredAgentSessionSend(
  context: StructuredAgentSessionMutationContext,
  ctx: SendContext,
  params: StructuredSendAdmissionParams,
  queueOnly = false
): Promise<TurnOutcome<AgentSessionSendResult> | null> {
  const captured = captureStructuredExecutionOptions(ctx, params.options, params.selection)
  if ('refusal' in captured) {
    return { ok: false as const, refusal: captured.refusal }
  }
  const fromPerson = params.userSend === true || params.personsMessage === true
  const source = fromPerson
    ? USER_MESSAGE_SOURCE
    : params.body.from
      ? AGENT_MESSAGE_SOURCE
      : undefined
  try {
    const commit = await ctx.journal.write(
      {
        kind: 'send-admission',
        input: {
          clientMessageId: params.envelope.clientOperationId,
          body: params.body,
          payloadFingerprint: agentSessionSendBodyFingerprint(ctx.sessionId, params.body),
          fence: ctx.fence,
          handoverRecorded: true,
          origin: params.userSend ? 'client' : 'host',
          ...(source ? { source } : {}),
          options: captured.options
        },
        fromPerson,
        fromAgent: !fromPerson && params.body.from !== undefined,
        deliveryMode: params.delivery === 'queue-if-active' ? 'queue' : 'steer',
        ...(queueOnly ? { queueOnly: true } : {}),
        ...(params.usageLimitContinuationOfTurnItemId !== undefined
          ? { continuationOfTurnItemId: params.usageLimitContinuationOfTurnItemId }
          : {})
      },
      () => ({
        facts: {
          send: copyJournalCurrentWorkAuthority(
            captureHostStructuredAgentSessionWork(
              { store: context.deps.store, sessions: context.sessions },
              ctx.sessionId,
              ctx.journal
            )
          )
        },
        custody: (sender) => context.deps.queuedAgentMessageOwed?.(ctx.sessionId, sender) ?? 'owed',
        ...(ctx.operationReceipt ? { receipt: ctx.operationReceipt } : {})
      })
    )
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this named command returns its admission result.
    const result = commit.value as JournalSendAdmissionResult
    if (result.kind === 'immediate') {
      if (!queueOnly) {
        throw new Error('send admission did not accept the message')
      }
      return null
    }
    if (result.kind === 'refused') {
      return { ok: false as const, refusal: result.refusal }
    }
    if (result.kind !== 'admitted') {
      throw new Error('send admission left mail custody unanswered')
    }
    return { ok: true as const, value: result.value }
  } catch (error) {
    return agentSessionAdmissionWriteRefusal(ctx, error)
  }
}

/** Commands share the queue decision, then execute their own immediate operation. */
export function maybeQueueStructuredAgentSessionSend(
  context: StructuredAgentSessionMutationContext,
  ctx: SendContext,
  params: StructuredSendAdmissionParams
) {
  return admitStructuredAgentSessionSend(context, ctx, params, true)
}
