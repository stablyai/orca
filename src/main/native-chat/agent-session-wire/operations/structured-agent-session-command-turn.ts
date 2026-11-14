import { isStructuredAgentSessionStopNote } from '../../../../shared/agent-session/view/structured-agent-session-stop-note-identity'
export {
  isStructuredAgentSessionStopNote,
  structuredAgentSessionStopNoteIdentity
} from '../../../../shared/agent-session/view/structured-agent-session-stop-note-identity'
import type { JournalWorkReader } from '../../agent-session-journal/journal-work-read'
// Delivery opens command turns; provider receipts settle sends and translator frames end turns.
// Running commands block input; the host ends refused commands or recovers exited children.

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
import type {
  AgentJournalItemBody,
  AgentJournalMessageItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session/journal/agent-session-journal-types'
import {
  agentSessionCompactCommandText,
  type AgentSessionConversationCommand
} from '../../../../shared/agent-session/agent-session-conversation-command'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import type { AgentChildWorkView } from '../../../../shared/agent-status/child-work/agent-status-child-work-view'
import { agentSessionRefusalReference } from '../../../../shared/agent-session/failures/agent-session-wire-refusals'
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

export const STRUCTURED_AGENT_SESSION_COMPACT_COMMAND = 'compact'

export function structuredAgentSessionCompactBody(instructions?: string): AgentJournalMessageItem {
  return {
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text: agentSessionCompactCommandText(instructions) }],
    command: {
      name: STRUCTURED_AGENT_SESSION_COMPACT_COMMAND,
      ...(instructions ? { instructions } : {})
    }
  }
}

type AwaitedSubmission = Pick<
  AgentJournalSubmission,
  'clientMessageId' | 'dispatchState' | 'acceptedSequence'
>

export type StructuredAgentSessionAwaitedCommandJournal = {
  inputOrder?: { recoverableSubmissions: () => readonly AwaitedSubmission[] }
  submissions?: () => readonly AwaitedSubmission[]
  itemBody: (itemId: string) => AgentJournalItemBody | null
}

/** Find the oldest awaited command so failed starts preserve the command for explicit retry. */
export function structuredAgentSessionAwaitedCommand(
  journal: StructuredAgentSessionAwaitedCommandJournal
): AgentSessionConversationCommand | undefined {
  let oldest: AwaitedSubmission | undefined
  for (const submission of journal.inputOrder?.recoverableSubmissions() ??
    journal.submissions?.() ??
    []) {
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

/** Read Stop from the journal so cached state cannot outlive the command. */
export async function structuredAgentSessionCommandWasStopped(
  journal: Pick<AgentSessionJournal, 'reads'>,
  turnId: string
): Promise<boolean> {
  const { itemId } = structuredAgentSessionCommandTurn(turnId.slice('compact:'.length))
  let stopped = false
  await journal.reads.visitItems(
    { kinds: ['status'] },
    (noteId, _sequence, _body, { turnScope }) => {
      stopped ||=
        turnScope?.kind === 'turn' &&
        turnScope.turnItemId === itemId &&
        isStructuredAgentSessionStopNote(noteId)
    }
  )
  return stopped
}

export type StructuredAgentSessionCommandHandoverContext = {
  sessionId: string
  journal: AgentSessionJournal
  fence: number
  adapter: StructuredAgentSessionAdapter
  agents: StructuredAgentRegistry
  readWork?: JournalWorkReader
  failureTextContext?: AgentSessionFailureWordsContext
  record: () => AgentSessionRecord | null
  /** Recheck execution-host ownership at admission and handover. */
  currentWork?: () => Promise<StructuredAgentSessionCurrentWork | null>
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
  const blocked = await commandBlocked(ctx, body)
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
  const instructions = body.command?.instructions
  let admission: AgentSessionCommandAdmission
  try {
    admission = await ctx.adapter.compact!({
      sessionId: ctx.sessionId,
      fence: ctx.fence,
      command: { clientMessageId, ...turn, running, ...(instructions ? { instructions } : {}) }
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
  return ctx.journal.openCommand({
    clientMessageId: submission.clientMessageId,
    submittedAt: submission.submittedAt,
    fence: ctx.fence,
    turnScope: (await contextStructuredAgentSessionCurrentWork(ctx)).turnScope()
  })
}

/** Start work timing at handover, excluding waits behind commands/startup. */
export async function structuredAgentSessionHandoverOrigin(
  journal: AgentSessionJournal,
  submission: AgentJournalSubmission
): Promise<number> {
  const handedOver = await journal.reads.submission(submission.clientMessageId)
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
  await ctx.journal.settleCommand({
    dispatch: { clientMessageId, ...unsent, fence: ctx.fence },
    ...(unsent.state === 'rejected'
      ? {
          failureBody: {
            kind: 'status',
            ...agentSessionFailureWords(rowFailure ?? unsent.rejection, {
              ...ctx.failureTextContext,
              surface: 'row'
            }),
            tone: 'error'
          }
        }
      : {})
  })
}

async function commandBlocked(
  ctx: StructuredAgentSessionCommandHandoverContext,
  body: AgentJournalMessageItem
): Promise<SubmissionRejectionFact | null> {
  if (body.command?.name !== STRUCTURED_AGENT_SESSION_COMPACT_COMMAND) {
    return agentSessionFailureFact('commandRefused')
  }
  const record = ctx.record()
  if (!record) {
    return agentSessionFailureFact('hostFault')
  }
  // Validate capability even if a client sends an unadvertised command or instructions.
  const capabilities = ctx.agents.capabilities(record.provider)
  if (!capabilities?.compact || (body.command.instructions && !capabilities.compactInstructions)) {
    return agentSessionFailureFact('commandRefused')
  }
  const childWork = () => ({ views: ctx.childWork(), open: ctx.childWorkOpen() })
  const refusal = await conversationCommandBlocked(
    ctx,
    record,
    compactionChildWork(capabilities, childWork),
    'handover'
  )
  return refusal
    ? agentSessionFailureFact('commandRefused', { refusal: agentSessionRefusalReference(refusal) })
    : null
}
