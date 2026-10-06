// A conversation command the user sent, such as `/compact`, carried out as a turn of its own.
//
// The command is an ordinary queued message until the delivery loop hands it over. There the loop
// opens the command's turn and sends it; the provider's receipt resolves the message, as it does
// any send. The provider child's journal translator ends the turn from the provider's own frames,
// and a child that ends first is settled with it. The host writes a command's end only when the
// provider never took it. While the turn runs it takes no input, so the loop hands nothing over.

import {
  agentSessionFailureFact,
  type AgentSessionFailureFact
} from '../../../shared/agent-session-failure'
import {
  agentSessionFailureWords,
  type AgentJournalDispatchRejection,
  type AgentSessionFailureWordsContext
} from '../../../shared/agent-session-failure-words'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey,
  parseAgentJournalItemKey
} from '../../../shared/agent-session-journal-item-key'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemIdentity,
  type AgentJournalMessageItem,
  type AgentJournalStatusItem,
  type AgentJournalSubmission
} from '../../../shared/agent-session-journal-types'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentChildWorkView } from '../../../shared/agent-status-child-work-view'
import {
  agentJournalTurnBody,
  readAgentJournalTurn
} from '../../../shared/agent-session-turn-record'
import type { JournalLifecycleMutationInput } from '../agent-session-journal/journal-row-builders'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type {
  AgentSessionCommandAdmission,
  StructuredAgentSessionAdapter,
  StructuredAgentSessionProviderChildPhase
} from './structured-agent-session-adapter'
import { commandBlocked } from './structured-agent-session-command-handover-block'

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

/** The command's turn: its record and the `turnId` a Stop names. The `compact:` prefix is how the
 *  host's Stop and delivery gate tell a command's turn from any other. */
export function structuredAgentSessionCommandTurn(clientMessageId: string): {
  identity: AgentJournalItemIdentity
  itemId: string
  turnId: string
  /** The command's one result row, inside its turn. */
  resultIdentity: AgentJournalItemIdentity
} {
  const identity = { provider: 'orca' as const, clientMessageId: `command-turn:${clientMessageId}` }
  return {
    identity,
    itemId: agentJournalItemKey(identity),
    turnId: `compact:${clientMessageId}`,
    resultIdentity: { provider: 'orca', clientMessageId: `command-result:${clientMessageId}` }
  }
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
  providerChildPhase?: () => StructuredAgentSessionProviderChildPhase | undefined
  /** Who a failure the handover meets names, as the start's own row does. */
  failureTextContext?: AgentSessionFailureWordsContext
  record: () => AgentSessionRecord | null
  /** The session's child records, the same read the strip and conversation-command admission use. */
  childWork: () => readonly AgentChildWorkView[] | undefined
  now: () => number
}

/** Refuses the command, or opens its turn and sends it. Returns the cause when the child's start
 *  failed at the handover, leaving the command handed over for the delivery loop to record. */
export async function handOverStructuredAgentSessionCommand(
  ctx: StructuredAgentSessionCommandHandoverContext,
  submission: AgentJournalSubmission,
  body: AgentJournalMessageItem
): Promise<{ error: unknown } | null> {
  const { clientMessageId } = submission
  // Provider frames already received decide whether a turn is running: each landed at its call.
  const blocked = commandBlocked(ctx, body)
  if (blocked) {
    await ctx.journal.resolveDispatch({
      clientMessageId,
      state: 'rejected',
      ...agentSessionFailureWords(blocked, { ...ctx.failureTextContext, surface: 'rejection' }),
      fence: ctx.fence
    })
    return null
  }
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
  let admission: AgentSessionCommandAdmission
  try {
    admission = await ctx.adapter.compact!({
      sessionId: ctx.sessionId,
      fence: ctx.fence,
      command: { clientMessageId, ...turn, running }
    })
  } catch (error) {
    // A child that had not proven its start took nothing: its start failed. Any other throw is a
    // lost reply: the command may have run.
    if (ctx.providerChildPhase?.() === 'starting') {
      return { error }
    }
    await settleUnsentCommand(ctx, clientMessageId, {
      state: 'unknown',
      reason: error instanceof Error ? error.message : String(error)
    })
    return null
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
  return null
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
  await ctx.journal.resolveDispatch({ clientMessageId, ...unsent, fence: ctx.fence })
  await endUnsentCommandTurn(
    ctx,
    clientMessageId,
    unsent.state === 'rejected'
      ? {
          kind: 'status',
          ...agentSessionFailureWords(rowFailure ?? unsent.rejection, {
            ...ctx.failureTextContext,
            surface: 'row'
          }),
          tone: 'error'
        }
      : null
  )
}

/** What ending a command's turn reads and writes. */
type CommandTurnEndContext = {
  journal: Pick<AgentSessionJournal, 'itemBody' | 'appendLifecycleBatch'>
  fence: number
  now: () => number
}

/** A command whose start failed, once the delivery loop recorded that on its message: its turn
 *  ends failed, and the message says why. */
export async function endStructuredAgentSessionCommandStartFailure(
  ctx: CommandTurnEndContext,
  clientMessageId: string
): Promise<void> {
  await endUnsentCommandTurn(ctx, clientMessageId, 'failed')
}

/** Ends the command's turn if it still runs: failed when the command was refused (`result` is its
 *  row, if it has one of its own), else unverifiable. */
async function endUnsentCommandTurn(
  ctx: CommandTurnEndContext,
  clientMessageId: string,
  result: AgentJournalStatusItem | 'failed' | null
): Promise<void> {
  const turn = structuredAgentSessionCommandTurn(clientMessageId)
  const running = readAgentJournalTurn(ctx.journal.itemBody(turn.itemId) ?? undefined)
  if (running?.state !== 'running') {
    return
  }
  const mutations: JournalLifecycleMutationInput[] = [
    ...(result && result !== 'failed'
      ? [
          {
            kind: 'item' as const,
            identity: turn.resultIdentity,
            body: result,
            turnScope: { kind: 'turn' as const, turnItemId: turn.itemId }
          }
        ]
      : []),
    {
      kind: 'item',
      identity: turn.identity,
      body: agentJournalTurnBody({
        ...running,
        ...(result
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
