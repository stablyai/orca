// Share mutation admission/planning/publication. Conversation writes need no child lease;
// provider-only effects start their child before admission, sends start through delivery.

import { latestNativeChatUsageLimitCut } from '../../../shared/native-chat/native-chat-usage-limit-cut'
import {
  refuse,
  type AgentSessionCancelResult,
  type AgentSessionMutationEnvelope,
  type AgentSessionMutationResult,
  type AgentSessionOptionResult,
  type AgentSessionPromptResult,
  type AgentSessionSendResult
} from '../../../shared/agent-session-wire'
import { contextStructuredAgentSessionCurrentWork } from './structured-agent-session-current-work'
import { shouldQueueStructuredAgentSessionSend } from './structured-agent-session-queued-messages'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import type {
  AgentSessionThreadGoalChange,
  AgentSessionThreadGoalResult
} from '../../../shared/agent-session/agent-session-thread-goal-wire'
import type { AgentSessionPromptRequest } from './structured-agent-session-turns-prompt'
import { refuseThreadGoalUnsupported, threadGoalPlan } from './structured-agent-session-thread-goal'
import {
  mutateStructuredAgentSession,
  runStructuredAgentSessionMutation,
  type StructuredAgentSessionMutationContext
} from './structured-agent-session-mutation-context'
import {
  openForProviderWrite,
  openForWrite,
  sendPreparation,
  structuredAgentSessionSendBlock
} from './structured-agent-session-send-preparation'
import {
  cancelPlan,
  promptPlan,
  sendPlan,
  setOptionPlan,
  type MutationPlan
} from './structured-agent-session-mutation-plans'
import { agentSessionMutationAdmitsNow } from './structured-agent-session-mutation-admits-now'
import { runQueueableStructuredAgentSessionSend } from './structured-agent-session-queued-send'
import { cancelStructuredAgentSessionPrompt } from './structured-agent-session-prompt-cancel'
import { mutateWithChatStop } from './structured-agent-session-chat-stop'
import {
  runWithReadyStructuredAgentSessionOperation,
  openWithReadyStructuredAgentSessionChild,
  runAfterRewindStart
} from './structured-agent-session-ready-operation'
export type { StructuredAgentSessionMutationContext } from './structured-agent-session-mutation-context'
import type { StructuredAgentSessionCaller } from './structured-agent-session-host-types'
import { recordStructuredAgentSessionOptionIntent } from './structured-agent-session-options-read'
import { confirmIdleStructuredAgentSessionOption } from './structured-agent-session-idle-option'

export function sendStructuredAgentSessionTurn(
  context: StructuredAgentSessionMutationContext,
  caller: StructuredAgentSessionCaller,
  params: {
    envelope: AgentSessionMutationEnvelope
    body: AgentJournalMessageItem
    retryUnknown?: true
    delivery?: 'queue-if-active'
    queuedImageCards?: boolean
    options?: Readonly<Record<string, string>>
    selection?: Readonly<Record<string, string>>
    usageLimitContinuationOfTurnItemId?: string
    /** Client send RPCs set origin=client for recovery; host mail/continuations/launch sends omit it. */
    userSend?: true
    /** Host-origin personal text, including launch prompts; other agents carry from instead. */
    personsMessage?: true
    beforeRun?: () => void
  },
  arrival?: Parameters<typeof sendPreparation>[2]
): Promise<AgentSessionMutationResult<AgentSessionSendResult>> {
  const plan = sendPlan(params)
  return runAfterRewindStart(context, caller.callerKey, params.envelope, plan, (selection) =>
    runStructuredAgentSessionMutation(
      context,
      caller,
      params.envelope,
      {
        ...plan,
        run: async (ctx) => {
          const record = context.deps.store.getRecord(ctx.sessionId)
          const blocked = structuredAgentSessionSendBlock(record)
          if (blocked) {
            return blocked
          }
          if (params.usageLimitContinuationOfTurnItemId !== undefined) {
            const snapshot = ctx.journal.snapshot()
            const cut = latestNativeChatUsageLimitCut(snapshot.items, snapshot.submissions)
            if (
              cut?.turnItemId !== params.usageLimitContinuationOfTurnItemId ||
              shouldQueueStructuredAgentSessionSend({
                record,
                journal: ctx.journal,
                work: contextStructuredAgentSessionCurrentWork(ctx)
              })
            ) {
              return {
                ok: false as const,
                refusal: refuse(
                  'agent_session_operation_invalid',
                  { reason: 'continuationSuperseded' },
                  'This chat has moved on. Check the latest messages before continuing.'
                )
              }
            }
          }
          return runQueueableStructuredAgentSessionSend(context, ctx, params, () => plan.run(ctx))
        }
      },
      sendPreparation(context, params.envelope, arrival, selection)
    )
  )
}

export function cancelStructuredAgentSessionTurn(
  context: StructuredAgentSessionMutationContext,
  caller: StructuredAgentSessionCaller,
  params: {
    envelope: AgentSessionMutationEnvelope
    turnId?: string
    scope?: 'background-tasks'
    taskId?: string
    prompt?: { itemId: string; expectedRevision: number }
  }
): Promise<AgentSessionMutationResult<AgentSessionCancelResult>> {
  if (params.scope) {
    const { sessionId } = params.envelope
    return mutateStructuredAgentSession(
      context,
      caller,
      params.envelope,
      cancelPlan({
        ...params,
        childWork: () => context.readChildWork(sessionId),
        acknowledgeStops: (evidence) => context.publishChildWork(sessionId, evidence),
        captureStops: (targets) =>
          context.captureChildWorkStops(
            sessionId,
            targets.map((target) => target.providerId)
          ),
        // At rest, Stop all can end unlisted work with its agent.
        ...(params.taskId === undefined
          ? {
              unlisted: {
                present: () => context.childWorkIncomplete(sessionId),
                stop: () => context.stopAgent(sessionId, { cause: 'evict', resting: true })
              }
            }
          : {})
      }),
      openForProviderWrite(context, params.envelope)
    )
  }
  const plan = cancelPlan(params)
  const { prompt } = params
  const stoppedPrePrompt =
    !prompt && params.turnId === undefined
      ? abortProviderWaitForStop(context, caller, params.envelope, plan)
      : null
  // Only live-turn prompt Cancel reaches chat Stop; it shares the untargeted Stop path.
  const stopped = prompt
    ? { envelope: params.envelope }
    : {
        ...params,
        stoppedPrePrompt: stoppedPrePrompt?.reached === true,
        stoppedSend: stoppedPrePrompt?.handedOver === true
      }
  return mutateWithChatStop(context, caller, stopped, plan, (ctx, stop) =>
    prompt
      ? cancelStructuredAgentSessionPrompt(
          ctx,
          { ...(params.turnId !== undefined ? { turnId: params.turnId } : {}), prompt },
          { stop, interrupt: () => plan.run(ctx) }
        )
      : stop().then(({ outcome }) => outcome)
  )
}

/** Abort unnamed Stop’s startup waits immediately; named stale turns must leave newer starts alone. */
function abortProviderWaitForStop(
  context: StructuredAgentSessionMutationContext,
  caller: StructuredAgentSessionCaller,
  envelope: AgentSessionMutationEnvelope,
  plan: MutationPlan<AgentSessionCancelResult>
): { reached: boolean; handedOver: boolean } | null {
  const { store } = context.deps
  if (
    !agentSessionMutationAdmitsNow({
      store,
      callerKey: caller.callerKey,
      envelope,
      plan,
      now: context.now
    })
  ) {
    return null
  }
  return context.acquireAborts.abort(envelope.sessionId, 'stopped while starting')
}

export function respondToStructuredAgentSessionPrompt(
  context: StructuredAgentSessionMutationContext,
  caller: StructuredAgentSessionCaller,
  params: AgentSessionPromptRequest & { envelope: AgentSessionMutationEnvelope }
): Promise<AgentSessionMutationResult<AgentSessionPromptResult>> {
  return mutateStructuredAgentSession(
    context,
    caller,
    params.envelope,
    promptPlan(params),
    openForProviderWrite(context, params.envelope)
  )
}

export async function setStructuredAgentSessionOption(
  context: StructuredAgentSessionMutationContext,
  caller: StructuredAgentSessionCaller,
  params: { envelope: AgentSessionMutationEnvelope; key: string; value: string }
): Promise<AgentSessionMutationResult<AgentSessionOptionResult>> {
  const plan = setOptionPlan(params)
  const noChoice =
    caller.readsOptionsWithoutModel === false && params.key === 'model' && params.value === ''
  return mutateStructuredAgentSession(
    context,
    caller,
    params.envelope,
    {
      ...plan,
      conversationWrite: true,
      run: async (ctx) => {
        const picked = await recordStructuredAgentSessionOptionIntent(context.deps, ctx, params, {
          readsWithoutModel: caller.readsOptionsWithoutModel !== false
        })
        if (picked.ok) {
          confirmIdleStructuredAgentSessionOption(context, ctx, params)
        }
        return picked
      },
      ...(noChoice
        ? {
            settledOutcome: (value: AgentSessionOptionResult) => ({
              status: 'succeeded' as const,
              sessionId: params.envelope.sessionId,
              optionResult: { version: 1, ...value }
            })
          }
        : {})
    },
    openForWrite(context, params.envelope)
  )
}

export async function changeStructuredAgentSessionThreadGoal(
  context: StructuredAgentSessionMutationContext,
  caller: StructuredAgentSessionCaller,
  params: { envelope: AgentSessionMutationEnvelope; change: AgentSessionThreadGoalChange }
): Promise<AgentSessionMutationResult<AgentSessionThreadGoalResult>> {
  const plan = threadGoalPlan(params)
  return runWithReadyStructuredAgentSessionOperation(
    context,
    caller.callerKey,
    params.envelope,
    plan,
    (selection) =>
      runStructuredAgentSessionMutation(
        context,
        caller,
        params.envelope,
        threadGoalPlan({ ...params, signal: selection.signal }),
        openWithReadyStructuredAgentSessionChild(context, params.envelope, selection)
      ),
    {
      goal: true,
      beforeAgent: (record) =>
        refuseThreadGoalUnsupported(context.deps.adapter, context.deps.agents, record?.provider)
    }
  )
}
