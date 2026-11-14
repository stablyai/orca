export {
  STRUCTURED_AGENT_SESSION_COMPACT_COMMAND,
  structuredAgentSessionCompactBody,
  structuredAgentSessionAwaitedCommand,
  type StructuredAgentSessionAwaitedCommandJournal,
  structuredAgentSessionCommandRunning,
  isStructuredAgentSessionCommandTurnId,
  structuredAgentSessionStopNoteIdentity,
  isStructuredAgentSessionStopNote,
  structuredAgentSessionCommandWasStopped
} from './structured-agent-session-command-record'
// Delivery opens command turns; provider receipts settle sends and translator frames end turns.
// Running commands block input; the host ends refused commands or recovers exited children.

import { AgentSessionReviewTargetSchema } from '../../../../shared/agent-session/agent-session-review-target'
import {
  agentSessionFailureFact,
  type AgentSessionFailureFact,
  type SubmissionRejectionFact
} from '../../../../shared/agent-session/failures/agent-session-failure'
import {
  agentSessionFailureWords,
  type AgentJournalDispatchRejection,
  type AgentSessionFailureWordsContext
} from '../../../../shared/agent-session/failures/agent-session-failure-words'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalMessageItem,
  type AgentJournalSubmission
} from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import type { AgentChildWorkView } from '../../../../shared/agent-status/child-work/agent-status-child-work-view'
import { agentSessionRefusalReference } from '../../../../shared/agent-session/failures/agent-session-wire-refusals'
import {
  agentJournalTurnBody,
  readAgentJournalTurn
} from '../../../../shared/agent-session/lifecycle/agent-session-turn-record'
import type { JournalLifecycleMutationInput } from '../../agent-session-journal/writing/journal-lifecycle-mutation'
import type { AgentSessionJournal } from '../../agent-session-journal/journal-store'
import type {
  AgentSessionCommandAdmission,
  StructuredAgentSessionAdapter
} from '../providers/structured-agent-session-adapter'
import type { StructuredAgentRegistry } from '../providers/structured-agent-registry'
import {
  compactionChildWork,
  conversationCommandBlocked
} from './structured-conversation-command-admission'
import { structuredAgentSessionCommandTurn } from '../../../../shared/agent-session/view/structured-agent-session-command-turn-identity'
import { refuseQueuedCommand } from '../delivery/structured-agent-session-queued-command-refusal'
import {
  contextStructuredAgentSessionCurrentWork,
  type StructuredAgentSessionCurrentWork
} from '../observations/structured-agent-session-current-work'

export type StructuredAgentSessionCommandHandoverContext = {
  sessionId: string
  journal: AgentSessionJournal
  fence: number
  adapter: StructuredAgentSessionAdapter
  agents: StructuredAgentRegistry
  failureTextContext?: AgentSessionFailureWordsContext
  record: () => AgentSessionRecord | null
  /** Recheck execution-host ownership at admission and handover. */
  currentWork?: () => StructuredAgentSessionCurrentWork | null
  childWork: () => readonly AgentChildWorkView[] | undefined
  childWorkOpen: () => boolean
  now: () => number
}

export async function handOverStructuredAgentSessionCommand(
  ctx: StructuredAgentSessionCommandHandoverContext,
  submission: AgentJournalSubmission,
  body: AgentJournalMessageItem
): Promise<void> {
  const { clientMessageId } = submission
  const name = body.command?.name === 'review' ? 'review' : 'compact'
  const blocked = commandBlocked(ctx, body)
  if (blocked) {
    const refused = {
      state: 'rejected' as const,
      ...agentSessionFailureWords(blocked, {
        ...ctx.failureTextContext,
        command: name,
        surface: 'rejection'
      })
    }
    if (submission.queuedMessageId === undefined) {
      // Direct command RPC already has a waiting reader for its refusal.
      await ctx.journal.resolveDispatch({ clientMessageId, ...refused, fence: ctx.fence })
      return
    }
    // Queued commands need an explicit result row because no RPC waits on refusal.
    await refuseQueuedCommand(ctx, submission, blocked, refused, name)
    return
  }
  const { turn, running } = await openCommandTurn(ctx, submission)
  const instructions = body.command?.instructions
  let admission: AgentSessionCommandAdmission
  try {
    admission = await ctx.adapter[name]!({
      sessionId: ctx.sessionId,
      fence: ctx.fence,
      command: {
        clientMessageId,
        ...turn,
        running,
        name,
        ...(instructions ? { instructions } : {}),
        ...(body.command?.review
          ? { review: AgentSessionReviewTargetSchema.parse(body.command.review) }
          : {})
      },
      ...(submission.options ? { executionOptions: submission.options } : {})
    })
  } catch (error) {
    // Ready-child writes can lose replies after running; never infer non-delivery from throws.
    await settleUnsentCommand(ctx, clientMessageId, {
      state: 'unknown',
      reason: error instanceof Error ? error.message : String(error)
    })
    return
  }
  if (admission.state === 'rejected') {
    await settleUnsentCommand(
      ctx,
      clientMessageId,
      admission,
      name === 'review'
        ? admission.rejection
        : agentSessionFailureFact('compactionFailed', { detail: admission.rejection.detail })
    )
  } else if (admission.state !== 'admitted') {
    // Unknown writes leave lifecycle settlement to provider frames or child exit.
    await ctx.journal.resolveDispatch({ clientMessageId, ...admission, fence: ctx.fence })
  }
}

async function openCommandTurn(
  ctx: StructuredAgentSessionCommandHandoverContext,
  submission: AgentJournalSubmission
) {
  const { clientMessageId } = submission
  const turn = structuredAgentSessionCommandTurn(clientMessageId)
  await ctx.journal.resolveDispatch({
    clientMessageId,
    state: 'pending',
    fence: ctx.fence,
    // Join only current execution, never ended-generation turns.
    turnScope: contextStructuredAgentSessionCurrentWork(ctx).turnScope()
  })
  const startedAt = ctx.now()
  const running = agentJournalTurnBody({
    turnId: turn.turnId,
    state: 'running',
    userItemId: agentJournalSubmissionKey(clientMessageId),
    requestedAt: structuredAgentSessionHandoverOrigin(ctx.journal, submission),
    startedAt
  })
  await ctx.journal.appendItem(turn.identity, running, {
    fence: ctx.fence,
    observedAt: startedAt,
    turnScope: AGENT_JOURNAL_THREAD_SCOPE
  })
  return { turn, running }
}

/** Start work timing at handover, excluding waits behind commands/startup. */
export function structuredAgentSessionHandoverOrigin(
  journal: AgentSessionJournal,
  submission: AgentJournalSubmission
): number {
  const handedOver = journal.submission(submission.clientMessageId)
  return handedOver?.handedOverAt ?? submission.submittedAt
}

/** Settle the send before its turn so crashes leave recoverable running work, never ended-but-in-flight sends. */
async function settleUnsentCommand(
  ctx: StructuredAgentSessionCommandHandoverContext,
  clientMessageId: string,
  unsent:
    | ({ state: 'rejected' } & AgentJournalDispatchRejection)
    | { state: 'unknown'; reason: string },
  rowFailure?: AgentSessionFailureFact
): Promise<void> {
  const turn = structuredAgentSessionCommandTurn(clientMessageId)
  const running = readAgentJournalTurn(ctx.journal.itemBody(turn.itemId) ?? undefined)
  await ctx.journal.resolveDispatch({ clientMessageId, ...unsent, fence: ctx.fence })
  if (running?.state !== 'running') {
    return
  }
  const refused = unsent.state === 'rejected'
  const mutations: JournalLifecycleMutationInput[] = [
    ...(refused
      ? [
          {
            kind: 'item' as const,
            identity: turn.resultIdentity,
            body: {
              kind: 'status' as const,
              ...agentSessionFailureWords(rowFailure ?? unsent.rejection, {
                ...ctx.failureTextContext,
                surface: 'row'
              }),
              tone: 'error' as const
            },
            turnScope: { kind: 'turn' as const, turnItemId: turn.itemId }
          }
        ]
      : []),
    {
      kind: 'item',
      identity: turn.identity,
      body: agentJournalTurnBody({
        ...running,
        ...(refused
          ? { state: 'completed', outcome: 'failure', completedAt: ctx.now() }
          : { state: 'unverifiable' })
      }),
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    }
  ]
  await ctx.journal.appendLifecycleBatch({
    settlementId: `command-settled:${clientMessageId}`,
    fence: ctx.fence,
    mutations
  })
}

function commandBlocked(
  ctx: StructuredAgentSessionCommandHandoverContext,
  body: AgentJournalMessageItem
): SubmissionRejectionFact | null {
  if (body.command?.name !== 'compact' && body.command?.name !== 'review') {
    return agentSessionFailureFact('commandRefused')
  }
  const record = ctx.record()
  if (!record) {
    return agentSessionFailureFact('hostFault')
  }
  // Validate capability even if a client sends an unadvertised command or instructions.
  const capabilities = ctx.agents.capabilities(record.provider)
  if (
    body.command.name === 'review'
      ? !capabilities?.review ||
        !AgentSessionReviewTargetSchema.safeParse(body.command.review).success
      : !capabilities?.compact || (body.command.instructions && !capabilities.compactInstructions)
  ) {
    return agentSessionFailureFact('commandRefused')
  }
  const childWork = () => ({ views: ctx.childWork(), open: ctx.childWorkOpen() })
  const refusal = conversationCommandBlocked(
    ctx,
    record,
    compactionChildWork(
      {
        compactBesideBackgroundTasks:
          body.command.name === 'review' || capabilities?.compactBesideBackgroundTasks
      },
      childWork
    ),
    'handover'
  )
  return refusal
    ? agentSessionFailureFact('commandRefused', { refusal: agentSessionRefusalReference(refusal) })
    : null
}
