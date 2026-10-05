// The status feed's per-journal projection, cached per commit: what a session's journal says its
// row is, and the user's newest send the provider accepted.

import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionHandleProvider } from '../../../shared/agent-session-provider-handle'
import { compareAgentJournalItems } from '../../../shared/agent-session-journal-position'
import {
  deriveJournalAsyncQuestionSuffix,
  journalSubmissionLookup,
  type AsyncQuestionJournalItem,
  type AsyncQuestionSubmissionLookup
} from '../../../shared/native-chat-async-question-facts'
import {
  nativeChatAsyncQuestionsFieldsEqual,
  publishNativeChatAsyncQuestions,
  type NativeChatAsyncQuestionsField
} from '../../../shared/native-chat-async-questions'
import { projectStructuredAgentSessionStatusState } from '../../../shared/structured-agent-session-projection'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { newestAcceptedSendKey } from './structured-agent-session-status-child-work'

export type StructuredAgentSessionStatusState = ReturnType<
  typeof projectStructuredAgentSessionStatusState
>

export type StructuredAgentSessionJournalProjection = {
  epoch: string
  sequence: number
  readOnly: boolean
  fence: number | undefined
  state: StructuredAgentSessionStatusState
  /** Null for an unreadable journal, which says nothing about the user's turns. */
  acceptedSendKey: string | null
}

export class StructuredAgentSessionJournalProjections {
  // Task progress must not sort and scan an unchanged conversation. Journal identity owns cleanup.
  private readonly byJournal = new WeakMap<
    AgentSessionJournal,
    StructuredAgentSessionJournalProjection
  >()

  read(
    journal: AgentSessionJournal,
    record: AgentSessionRecord | null
  ): StructuredAgentSessionJournalProjection {
    // An unreadable journal projects as "no turn": the chat itself shows the reset.
    const cursor = journal.cursor()
    const readOnly = journal.isReadOnly
    // The conversation's fence, which a child's end moves: its unanswered sends stop counting.
    const fence = record?.lease.runtimeFence
    let projection = this.byJournal.get(journal)
    if (
      !projection ||
      projection.epoch !== cursor.epoch ||
      projection.sequence !== cursor.sequence ||
      projection.readOnly !== readOnly ||
      projection.fence !== fence
    ) {
      // A journalled submission bumps `lastSequence`, so the send-time working
      // signal reaches the cache; the lease fence does not, hence the extra key.
      const snapshot = readOnly ? null : journal.snapshot()
      projection = {
        ...cursor,
        readOnly,
        fence,
        state: projectStructuredAgentSessionStatusState(
          snapshot?.items ?? [],
          snapshot?.submissions ?? [],
          fence
        ),
        acceptedSendKey: snapshot
          ? newestAcceptedSendKey(cursor.epoch, snapshot.submissions ?? [])
          : null
      }
      this.byJournal.set(journal, projection)
    }
    return projection
  }
}

const NO_ASYNC_QUESTIONS: NativeChatAsyncQuestionsField = { state: 'ready', questions: [] }

type AsyncQuestionsProjection = {
  epoch: string
  sequence: number
  readOnly: boolean
  field: NativeChatAsyncQuestionsField | undefined
  /** The newest delivered root user message so far; nothing before it can be pending. */
  boundary: AsyncQuestionJournalItem | null
}

// One derivation per journal commit, shared by every subscriber of the session.
const asyncQuestionsByJournal = new WeakMap<AgentSessionJournal, AsyncQuestionsProjection>()

/** Messages after `after` in journal order, read without a full sorted snapshot. */
function journalMessagesAfter(
  journal: AgentSessionJournal,
  after: AsyncQuestionJournalItem | null
): AsyncQuestionJournalItem[] {
  const messages: AsyncQuestionJournalItem[] = []
  journal.visitItemsWithLinkage((itemId, sequence, body, item) => {
    if (
      body.kind !== 'message' ||
      (after &&
        compareAgentJournalItems({ sequence, sequenceIndex: item.sequenceIndex }, after) <= 0)
    ) {
      return
    }
    messages.push({
      itemId,
      sequence,
      body,
      ...(item.sequenceIndex === undefined ? {} : { sequenceIndex: item.sequenceIndex }),
      ...(item.agentId === undefined ? {} : { agentId: item.agentId })
    })
  })
  return messages.sort(compareAgentJournalItems)
}

/** The pending Codex async questions the journal records, as published. Identity is stable while
 *  the set is unchanged, so subscribers can deduplicate it by reference. Only the messages after
 *  the newest delivered root user message are read, a boundary kept per epoch while its item
 *  stays. A known non-Codex provider never asks one. Undefined for a read-only journal: it can't
 *  derive, so it publishes nothing (old host). */
export function readStructuredAgentSessionAsyncQuestions(
  journal: AgentSessionJournal,
  provider?: AgentSessionHandleProvider
): NativeChatAsyncQuestionsField | undefined {
  const cursor = journal.cursor()
  const readOnly = journal.isReadOnly
  const cached = asyncQuestionsByJournal.get(journal)
  if (
    cached &&
    cached.epoch === cursor.epoch &&
    cached.sequence === cursor.sequence &&
    cached.readOnly === readOnly
  ) {
    return cached.field
  }
  let field: NativeChatAsyncQuestionsField | undefined = readOnly ? undefined : NO_ASYNC_QUESTIONS
  let boundary: AsyncQuestionJournalItem | null = null
  if (!readOnly && (provider === undefined || provider === 'codex')) {
    const after =
      cached?.epoch === cursor.epoch && cached.boundary && journal.itemBody(cached.boundary.itemId)
        ? cached.boundary
        : null
    const messages = journalMessagesAfter(journal, after)
    // Only a pending send's message needs its submission; most suffixes hold none.
    let submissionFor: AsyncQuestionSubmissionLookup | null = null
    const derived = deriveJournalAsyncQuestionSuffix(messages, (itemId) => {
      submissionFor ??= journalSubmissionLookup(journal.submissions())
      return submissionFor(itemId)
    })
    boundary = derived.boundary ?? after
    if (derived.questions.length > 0) {
      field = publishNativeChatAsyncQuestions(derived.questions)
    }
  }
  if (cached && nativeChatAsyncQuestionsFieldsEqual(cached.field, field)) {
    field = cached.field
  }
  asyncQuestionsByJournal.set(journal, { ...cursor, readOnly, field, boundary })
  return field
}
