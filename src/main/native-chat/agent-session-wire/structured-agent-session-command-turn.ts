// A conversation command the user sent, such as `/compact`, carried out as a turn of its own.
//
// The command is an ordinary queued message until the delivery loop hands it over. There the loop
// opens the command's turn, starts the provider on it, and waits off the session's queue for the
// provider's end or the child's — a command turn takes no input, so nothing queued behind it is
// handed over meanwhile. The settle re-reads the journal: a child that died in between already
// wrote the verdict, so a turn no longer running or a message no longer in flight means there is
// nothing left to write.

import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../../shared/agent-session-journal-item-key'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemBody,
  type AgentJournalItemIdentity,
  type AgentJournalMessageItem,
  type AgentJournalSubmission,
  type AgentJournalTurnLifecycle
} from '../../../shared/agent-session-journal-types'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import {
  agentJournalTurnBody,
  readAgentJournalTurn
} from '../../../shared/agent-session-turn-record'
import { boundJournalStatusText } from '../agent-session-journal/journal-prompt-body-bounds'
import type { JournalLifecycleMutationInput } from '../agent-session-journal/journal-row-builders'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type {
  StructuredAgentSessionAdapter,
  StructuredAgentSessionProviderChildPhase
} from './structured-agent-session-adapter'
import { conversationCommandBlocked } from './structured-conversation-command-admission'
import type { StructuredSessionCompactionResult } from './structured-session-compaction'

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

/** The command's turn: its record and the `turnId` a Stop names. The `compact:` prefix is what the
 *  providers' cancel paths recognise as the command's. */
export function structuredAgentSessionCommandTurn(clientMessageId: string): {
  identity: AgentJournalItemIdentity
  itemId: string
  turnId: string
} {
  const identity = { provider: 'orca' as const, clientMessageId: `command-turn:${clientMessageId}` }
  return {
    identity,
    itemId: agentJournalItemKey(identity),
    turnId: `compact:${clientMessageId}`
  }
}

export function isStructuredAgentSessionCommandTurnId(turnId: string): boolean {
  return turnId.startsWith('compact:')
}

/** How the provider's run ended, or the adapter's throw and whether the child had proven its start. */
export type StructuredAgentSessionCommandEnd =
  | StructuredSessionCompactionResult
  | { thrown: string; starting: boolean }

export type StructuredAgentSessionCommandHandover = {
  clientMessageId: string
  completion: Promise<StructuredAgentSessionCommandEnd>
}

export type StructuredAgentSessionCommandHandoverContext = {
  sessionId: string
  journal: AgentSessionJournal
  fence: number
  adapter: StructuredAgentSessionAdapter
  providerChildPhase?: () => StructuredAgentSessionProviderChildPhase | undefined
  record: () => AgentSessionRecord | null
  flushStreamedEvents: () => Promise<void>
  now: () => number
}

/** Refuses the command, or opens its turn and starts the provider on it. */
export async function handOverStructuredAgentSessionCommand(
  ctx: StructuredAgentSessionCommandHandoverContext,
  submission: AgentJournalSubmission,
  body: AgentJournalMessageItem
): Promise<StructuredAgentSessionCommandHandover | null> {
  const { clientMessageId } = submission
  // Provider frames already received decide whether a turn is running.
  await ctx.flushStreamedEvents()
  const blocked = commandBlocked(ctx, body)
  if (blocked) {
    await ctx.journal.resolveDispatch({
      clientMessageId,
      state: 'rejected',
      reason: blocked,
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
  await ctx.journal.appendItem(
    turn.identity,
    agentJournalTurnBody({
      turnId: turn.turnId,
      state: 'running',
      userItemId: agentJournalSubmissionKey(clientMessageId),
      requestedAt: submission.submittedAt,
      startedAt
    }),
    { fence: ctx.fence, observedAt: startedAt, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  let completion: Promise<StructuredSessionCompactionResult>
  try {
    completion = ctx.adapter.compact!({
      turnId: turn.turnId,
      turnItemId: turn.itemId,
      sessionId: ctx.sessionId,
      fence: ctx.fence
    })
  } catch (error) {
    completion = Promise.reject(error)
  }
  return {
    clientMessageId,
    completion: completion.catch((error: unknown) => ({
      thrown: error instanceof Error ? error.message : String(error),
      // A child that had not proven its start took nothing, so the command provably did not run.
      starting: ctx.providerChildPhase?.() === 'starting'
    }))
  }
}

/** Writes the command's end, unless the journal already holds one. */
export async function settleStructuredAgentSessionCommand(
  ctx: { journal: AgentSessionJournal; fence: number; now: () => number },
  clientMessageId: string,
  end: StructuredAgentSessionCommandEnd
): Promise<void> {
  const turn = structuredAgentSessionCommandTurn(clientMessageId)
  const running = readAgentJournalTurn(ctx.journal.itemBody(turn.itemId) ?? undefined)
  const submission = ctx.journal
    .submissions()
    .find((entry) => entry.clientMessageId === clientMessageId)
  if (running?.state !== 'running' || submission?.dispatchState !== 'pending') {
    return
  }
  const completedAt = ctx.now()
  const verdict = commandVerdict(end, completedAt)
  const result = commandResultBody(end)
  const mutations: JournalLifecycleMutationInput[] = [
    ...(result
      ? [
          {
            kind: 'item' as const,
            identity: {
              provider: 'orca' as const,
              clientMessageId: `command-result:${clientMessageId}`
            },
            body: result,
            turnScope: { kind: 'turn' as const, turnItemId: turn.itemId }
          }
        ]
      : []),
    {
      kind: 'item',
      identity: turn.identity,
      body: agentJournalTurnBody({ ...running, ...verdict }),
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    }
  ]
  await ctx.journal.appendLifecycleBatch({
    settlementId: `command-settled:${clientMessageId}`,
    fence: ctx.fence,
    mutations
  })
  await ctx.journal.resolveDispatch(
    'thrown' in end
      ? {
          clientMessageId,
          state: end.starting ? 'rejected' : 'unknown',
          reason: end.thrown,
          fence: ctx.fence
        }
      : // The provider took the command and answered it in place; it echoes no item of its own.
        { clientMessageId, state: 'accepted', providerIdentity: null, fence: ctx.fence }
  )
}

function commandBlocked(
  ctx: StructuredAgentSessionCommandHandoverContext,
  body: AgentJournalMessageItem
): string | null {
  if (body.command?.name !== STRUCTURED_AGENT_SESSION_COMPACT_COMMAND || !ctx.adapter.compact) {
    return 'This agent cannot run that command.'
  }
  const record = ctx.record()
  return record
    ? conversationCommandBlocked(ctx, record, 'handover')
    : 'The conversation could not be read back, so the command was not run.'
}

function commandVerdict(
  end: StructuredAgentSessionCommandEnd,
  completedAt: number
): Pick<AgentJournalTurnLifecycle, 'state' | 'outcome' | 'completedAt'> {
  if ('thrown' in end) {
    // A throw after the start proved is a lost reply: the command may have run.
    return end.starting
      ? { state: 'completed', outcome: 'failure', completedAt }
      : { state: 'unverifiable' }
  }
  return end.outcome === 'cancellation'
    ? { state: 'interrupted', outcome: 'cancellation', completedAt }
    : { state: 'completed', outcome: end.outcome, completedAt }
}

function commandResultBody(end: StructuredAgentSessionCommandEnd): AgentJournalItemBody | null {
  if ('thrown' in end) {
    return end.starting
      ? { kind: 'status', text: boundJournalStatusText(end.thrown), tone: 'error' }
      : null
  }
  if (end.outcome === 'success') {
    return { kind: 'status', text: 'Conversation compacted.', presentation: 'compaction' }
  }
  return end.outcome === 'failure'
    ? {
        kind: 'status',
        text: boundJournalStatusText(end.error ?? 'Compaction did not complete.'),
        tone: 'error'
      }
    : null
}
