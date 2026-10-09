// A conversation command the user sent, such as `/compact`, carried out as a turn of its own.
//
// The command is an ordinary queued message until the delivery loop hands it over. There the loop
// opens the command's turn and sends it; the provider's receipt resolves the message, as it does
// any send. The provider child's journal translator ends the turn from the provider's own frames,
// and a child that ends first is settled with it. The host writes a command's end only when the
// provider never took it. While the turn runs it takes no input, so the loop hands nothing over.

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
import type { AgentSessionConversationCommand } from '../../../shared/agent-session-conversation-command'
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

export { structuredAgentSessionCommandTurn } from '../../../shared/structured-agent-session-command-turn-identity'

export const STRUCTURED_AGENT_SESSION_COMPACT_COMMAND = 'compact'

/** What the user sent for `/compact`: the text they typed, and the command it names. */
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

/** Optional `submissions` as the dead-generation journal reads it. */
export type StructuredAgentSessionAwaitedCommandJournal = {
  submissions?: () => readonly AwaitedSubmission[]
  itemBody: AgentSessionJournal['itemBody']
}

/** The command the oldest message still waiting on the provider names: a start that fails now
 *  fails that message first, so its next step is to run the command again. */
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

/** Whether the journal's running turn is a command's, which takes no input while it runs. */
export function structuredAgentSessionCommandRunning(
  journal: Pick<AgentSessionJournal, 'activeTurnId'>
): boolean {
  const turnId = journal.activeTurnId()
  return turnId !== null && isStructuredAgentSessionCommandTurnId(turnId)
}

export function isStructuredAgentSessionCommandTurnId(turnId: string): boolean {
  return turnId.startsWith('compact:')
}

const STOP_NOTE_PREFIX = 'stop:'

/** A Stop's note, keyed by the turn it stopped (or, with no turn, by its operation). */
export function structuredAgentSessionStopNoteIdentity(stopKey: string): AgentJournalItemIdentity {
  return { provider: 'orca', clientMessageId: `${STOP_NOTE_PREFIX}${stopKey}` }
}

/** Whether a journal row is a Stop's note. */
export function isStructuredAgentSessionStopNote(itemId: string): boolean {
  const identity = parseAgentJournalItemKey(itemId)
  return identity?.provider === 'orca' && identity.clientMessageId.startsWith(STOP_NOTE_PREFIX)
}

/** Whether an earlier Stop already asked the running command `turnId` names to end. Read from the
 *  journal, so nothing is held that could outlive the command. */
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
  /** Who a failure the handover meets names, as the start's own row does. */
  failureTextContext?: AgentSessionFailureWordsContext
  record: () => AgentSessionRecord | null
  /** The session's child records, the same read the strip and conversation-command admission use. */
  childWork: () => readonly AgentChildWorkView[] | undefined
  now: () => number
}

/** Refuses the command, or opens its turn and sends it. */
export async function handOverStructuredAgentSessionCommand(
  ctx: StructuredAgentSessionCommandHandoverContext,
  submission: AgentJournalSubmission,
  body: AgentJournalMessageItem
): Promise<void> {
  const { clientMessageId } = submission
  // Provider frames already received decide whether a turn is running: each landed at its call.
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
      // The command RPC that sent it is still waiting, and its answer says why.
      await ctx.journal.resolveDispatch({ clientMessageId, ...refused, fence: ctx.fence })
      return
    }
    // A queued card's refusal has nobody waiting on it: its turn's one row says why.
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
    // Handed over only to a child that proved its start, so a throw is a lost reply: it may have run.
    await settleUnsentCommand(ctx, clientMessageId, {
      state: 'unknown',
      reason: error instanceof Error ? error.message : String(error)
    })
    return
  }
  if (admission.state === 'rejected') {
    // The provider refused the compaction itself: its row reads as the compaction failing.
    await settleUnsentCommand(
      ctx,
      clientMessageId,
      admission,
      agentSessionFailureFact('compactionFailed', { detail: admission.rejection.detail })
    )
  } else if (admission.state !== 'admitted') {
    // An unknown write leaves the turn to the provider's end or the child's: it may have run.
    await ctx.journal.resolveDispatch({ clientMessageId, ...admission, fence: ctx.fence })
  }
}

/** Hands the command over and opens its own turn. */
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
    turnScope: ctx.journal.liveTurnScope()
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

/** Where the turn a handed-over submission runs in starts counting: its handover, so time spent
 *  held behind a command or a start is not counted as the agent's work. */
export function structuredAgentSessionHandoverOrigin(
  journal: AgentSessionJournal,
  submission: AgentJournalSubmission
): number {
  const handedOver = journal
    .submissions()
    .find((entry) => entry.clientMessageId === submission.clientMessageId)
  return handedOver?.handedOverAt ?? submission.submittedAt
}

/** The command's end when the provider never took it: refused, or lost with the adapter's throw.
 *  The message's answer goes first, so a crash before the turn's end leaves a running turn, which
 *  the stale-turn sweep settles, never an ended turn whose message still reads as in flight. */
async function settleUnsentCommand(
  ctx: StructuredAgentSessionCommandHandoverContext,
  clientMessageId: string,
  unsent:
    | ({ state: 'rejected' } & AgentJournalDispatchRejection)
    | { state: 'unknown'; reason: string },
  /** What the result row reports, when it is not the rejection's own fact. */
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

/** Why the command may not run now, as the fact its message is rejected with; null when it may. */
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
  // The declaration admits it, as it does the advertised command list; a client may send it anyway.
  if (!ctx.agents.capabilities(record.provider)?.compact) {
    return agentSessionFailureFact('commandRefused')
  }
  const refusal = conversationCommandBlocked(ctx, record, ctx.childWork(), 'handover')
  return refusal
    ? agentSessionFailureFact('commandRefused', { refusal: agentSessionRefusalReference(refusal) })
    : null
}
