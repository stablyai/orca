import { readWholeAgentSessionFailureFact } from '../../../shared/agent-session/failures/agent-session-failure'
import { isRootAgentJournalItem } from '../../../shared/agent-session/journal/agent-session-journal-producer'
import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import { agentJournalSubmissionKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import type {
  AgentJournalItemBody,
  AgentJournalMessageItem,
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import { latestStructuredAgentSessionPrompt } from '../../../shared/agent-session/requests/structured-agent-session-latest-request'
import {
  readJournalInput,
  type JournalInputRead,
  type JournalInputReadResult
} from './journal-input-reads'
import type { JournalItemLinkageVisitor } from './journal-store-contracts'
import type { JournalReducerState } from './projection/journal-reducer'

/** The live epoch with the sends accepted after an offer's cursor, read together. */
export type JournalRestartProgress = {
  epoch: string
  acceptedInputs: readonly AgentJournalSubmission[]
}

export type JournalOutgrownChildRead = { fence: number; nextClientMessageId?: string }

export type JournalOutgrownChild = {
  signedOut: boolean
  newestTurnCompletedAt: number | undefined
  nextMessage: AgentJournalMessageItem | null
}

/** One chat snapshot as both backends expose it to these lifecycle reads. */
export type JournalLifecycleSnapshot = {
  epoch: () => string
  input: (operation: JournalInputRead) => JournalInputReadResult
  /** Presented item body, as `reads.itemBody` answers it. */
  itemBody: (itemId: string) => AgentJournalItemBody | null | undefined
  /** Whether a presented root status at this execution fence reports sign-out. */
  rootStatusSignedOutAt: (fence: number) => boolean
}

/** A root status row reporting sign-out; a subagent's says nothing about the parent. */
export function journalStatusReportsSignedOut(
  body: AgentJournalItemBody,
  attribution: Pick<AgentJournalRenderItem, 'agentId'>
): boolean {
  return (
    body.kind === 'status' &&
    isRootAgentJournalItem(attribution) &&
    readWholeAgentSessionFailureFact(body.failure)?.kind === 'notSignedIn'
  )
}

export function readJournalRestartProgress(
  snapshot: JournalLifecycleSnapshot,
  cursor: AgentJournalCursor
): JournalRestartProgress {
  const accepted = snapshot.input({ kind: 'accepted-inputs-after', sequence: cursor.sequence })
  if (accepted.kind !== 'accepted-inputs-after') {
    throw new Error('journal accepted inputs read returned a different answer')
  }
  return { epoch: snapshot.epoch(), acceptedInputs: accepted.submissions }
}

export function readJournalOutgrownChild(
  snapshot: JournalLifecycleSnapshot,
  { fence, nextClientMessageId }: JournalOutgrownChildRead
): JournalOutgrownChild {
  const answer = snapshot.input({
    kind: 'batch',
    reads: [{ kind: 'signed-out-at', fence }, { kind: 'newest-turn' }]
  })
  const [rejected, newest] = answer.kind === 'batch' ? answer.results : []
  if (rejected?.kind !== 'signed-out-at' || newest?.kind !== 'newest-turn') {
    throw new Error('journal outgrown child read returned a different answer')
  }
  const body =
    nextClientMessageId === undefined
      ? null
      : snapshot.itemBody(agentJournalSubmissionKey(nextClientMessageId))
  return {
    signedOut: rejected.answer || snapshot.rootStatusSignedOutAt(fence),
    newestTurnCompletedAt: newest.turn?.completedAt,
    nextMessage: body?.kind === 'message' ? body : null
  }
}

type FoldedLifecycleJournal = {
  cursor(): AgentJournalCursor
  itemsRead(): { items: readonly AgentJournalRenderItem[] }
  itemBody(itemId: string): AgentJournalItemBody | null
  itemFence(itemId: string): number | undefined
  visitItemsWithLinkage(visit: JournalItemLinkageVisitor): void
}

/** The in-memory chat answers from its fold at call time. */
export function foldedJournalLifecycleReads(
  journal: FoldedLifecycleJournal,
  state: () => JournalReducerState
) {
  const snapshot: JournalLifecycleSnapshot = {
    epoch: () => journal.cursor().epoch,
    input: (operation) => readJournalInput(state(), operation),
    itemBody: journal.itemBody,
    rootStatusSignedOutAt: (fence) => {
      let found = false
      journal.visitItemsWithLinkage((itemId, _sequence, body, attribution) => {
        found ||=
          journalStatusReportsSignedOut(body, attribution) && journal.itemFence(itemId) === fence
      })
      return found
    }
  }
  return {
    latestPrompt: () => latestStructuredAgentSessionPrompt(journal.itemsRead().items),
    restartProgress: (cursor: AgentJournalCursor) => readJournalRestartProgress(snapshot, cursor),
    outgrownChild: (input: JournalOutgrownChildRead) => readJournalOutgrownChild(snapshot, input)
  }
}
