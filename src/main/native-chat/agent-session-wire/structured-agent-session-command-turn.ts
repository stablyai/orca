// Delivery opens command turns; provider receipts settle sends and translator frames end turns.
// Running commands block input; the host ends refused commands or recovers exited children.

import {
  agentSessionFailureFact,
  type AgentSessionFailureFact,
  type SubmissionRejectionFact
} from '../../../shared/agent-session-failure'
import {
  agentSessionFailureWords,
  type AgentJournalDispatchRejection,
  type AgentSessionFailureWordsContext
} from '../../../shared/agent-session-failure-words'
import {
  agentJournalSubmissionKey,
  parseAgentJournalItemKey
} from '../../../shared/agent-session-journal-item-key'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemIdentity,
  type AgentJournalMessageItem,
  type AgentJournalSubmission
} from '../../../shared/agent-session-journal-types'
import type { AgentSessionConversationCommand } from '../../../shared/agent-session/agent-session-conversation-command'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentChildWorkView } from '../../../shared/agent-status-child-work-view'
import { agentSessionRefusalReference } from '../../../shared/agent-session-wire-refusals'
import {
  agentJournalTurnBody,
  readAgentJournalTurn
} from '../../../shared/agent-session-turn-record'
import type { JournalLifecycleMutationInput } from '../agent-session-journal/journal-row-builders'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type {
  AgentSessionCommandAdmission,
  StructuredAgentSessionAdapter
} from './structured-agent-session-adapter'
import type { StructuredAgentRegistry } from './structured-agent-registry'
import { conversationCommandBlocked } from './structured-conversation-command-admission'
import { structuredAgentSessionCommandTurn } from '../../../shared/structured-agent-session-command-turn-identity'
import { refuseQueuedCommand } from './structured-agent-session-queued-command-refusal'
import {
  contextStructuredAgentSessionCurrentWork,
  type StructuredAgentSessionCurrentWork
} from './structured-agent-session-current-work'

export { structuredAgentSessionCommandTurn } from '../../../shared/structured-agent-session-command-turn-identity'

export const STRUCTURED_AGENT_SESSION_COMPACT_COMMAND = 'compact'

export function structuredAgentSessionCompactBody(): AgentJournalMessageItem {
  return {
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text: '/compact' }],
    command: { name: STRUCTURED_AGENT_SESSION_COMPACT_COMMAND }
  }
}

type AwaitedSubmission = Pick<
  AgentJournalSubmission,
  'clientMessageId' | 'dispatchState' | 'acceptedSequence'
>

export type StructuredAgentSessionAwaitedCommandJournal = {
  submissions?: () => readonly AwaitedSubmission[]
  itemBody: AgentSessionJournal['itemBody']
}

/** Find the oldest awaited command so failed starts preserve the command for explicit retry. */
export function structuredAgentSessionAwaitedCommand(
  journal: StructuredAgentSessionAwaitedCommandJournal
): AgentSessionConversationCommand | undefined {
  let oldest: AwaitedSubmission | undefined
  for (const submission of journal.submissions?.() ?? []) {
    if (
      submission.dispatchState === 'pending' &&
      (oldest === undefined || (submission.acceptedSequence ?? 0) < (oldest.acceptedSequence ?? 0))
    ) {
      oldest = submission
    }
  }
  const body = oldest && journal.itemBody(agentJournalSubmissionKey(oldest.clientMessageId))
  return body?.kind === 'message' && body.command?.name === STRUCTURED_AGENT_SESSION_COMPACT_COMMAND
    ? STRUCTURED_AGENT_SESSION_COMPACT_COMMAND
    : undefined
}

/** Command turns refuse input while their child runs. */
export function structuredAgentSessionCommandRunning(
  work: Pick<StructuredAgentSessionCurrentWork, 'activeTurnId'>
): boolean {
  const turnId = work.activeTurnId()
  return turnId !== null && isStructuredAgentSessionCommandTurnId(turnId)
}

export function isStructuredAgentSessionCommandTurnId(turnId: string): boolean {
  return turnId.startsWith('compact:')
}

const STOP_NOTE_PREFIX = 'stop:'

export function structuredAgentSessionStopNoteIdentity(stopKey: string): AgentJournalItemIdentity {
  return { provider: 'orca', clientMessageId: `${STOP_NOTE_PREFIX}${stopKey}` }
}

export function isStructuredAgentSessionStopNote(itemId: string): boolean {
  const identity = parseAgentJournalItemKey(itemId)
  return identity?.provider === 'orca' && identity.clientMessageId.startsWith(STOP_NOTE_PREFIX)
}

/** Read Stop from the journal so cached state cannot outlive the command. */
export function structuredAgentSessionCommandWasStopped(
  journal: Pick<AgentSessionJournal, 'snapshot'>,
  turnId: string
): boolean {
  const { itemId } = structuredAgentSessionCommandTurn(turnId.slice('compact:'.length))
  return journal
    .snapshot()
    .items.some(
      (item) =>
        item.turnScope?.kind === 'turn' &&
        item.turnScope.turnItemId === itemId &&
        isStructuredAgentSessionStopNote(item.itemId)
    )
}

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
  const blocked = commandBlocked(ctx, body)
  if (blocked) {
    const refused = {
      state: 'rejected' as const,
      ...agentSessionFailureWords(blocked, {
        ...ctx.failureTextContext,
        command: STRUCTURED_AGENT_SESSION_COMPACT_COMMAND,
        surface: 'rejection'
      })
    }
    if (submission.queuedMessageId === undefined) {
      // Direct command RPC already has a waiting reader for its refusal.
      await ctx.journal.resolveDispatch({ clientMessageId, ...refused, fence: ctx.fence })
      return
    }
    // Queued commands need an explicit result row because no RPC waits on refusal.
    await refuseQueuedCommand(
      ctx,
      submission,
      blocked,
      refused,
      STRUCTURED_AGENT_SESSION_COMPACT_COMMAND
    )
    return
  }
  const { turn, running } = await openCommandTurn(ctx, submission)
  let admission: AgentSessionCommandAdmission
  try {
    admission = await ctx.adapter.compact!({
      sessionId: ctx.sessionId,
      fence: ctx.fence,
      command: { clientMessageId, ...turn, running }
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
      agentSessionFailureFact('compactionFailed', { detail: admission.rejection.detail })
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
  const handedOver = journal
    .submissions()
    .find((entry) => entry.clientMessageId === submission.clientMessageId)
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
  if (body.command?.name !== STRUCTURED_AGENT_SESSION_COMPACT_COMMAND) {
    return agentSessionFailureFact('commandRefused')
  }
  const record = ctx.record()
  if (!record) {
    return agentSessionFailureFact('hostFault')
  }
  // Validate capability even if a client sends an unadvertised command.
  if (!ctx.agents.capabilities(record.provider)?.compact) {
    return agentSessionFailureFact('commandRefused')
  }
  const refusal = conversationCommandBlocked(
    ctx,
    record,
    { views: ctx.childWork(), open: ctx.childWorkOpen() },
    'handover'
  )
  return refusal
    ? agentSessionFailureFact('commandRefused', { refusal: agentSessionRefusalReference(refusal) })
    : null
}
