import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session-queued-submission'
import { isJournalStopOrResumeRow } from '../agent-session-journal/journal-row-schema'
import { isAgentSessionContextClear } from '../../../shared/agent-session-context-clear'
import { StructuredQueuedNativeResponses } from './structured-agent-session-queued-native-responses'
import { StructuredAccountRecovery } from './structured-agent-session-account-recovery'
import { readWholeAgentSessionFailureFact } from '../../../shared/agent-session-failure'
import {
  agentJournalSubmissionKey,
  parseAgentJournalItemKey
} from '../../../shared/agent-session-journal-item-key'
import { isRootAgentJournalItem } from '../../../shared/agent-session-journal-producer'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import type {
  AgentJournalCursor,
  AgentJournalItemBody,
  AgentJournalRenderItem
} from '../../../shared/agent-session-journal-types'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { JournalRow } from '../agent-session-journal/journal-row-schema'
import type {
  JournalOutcomeReadRow,
  JournalReadRow
} from '../agent-session-journal/journal-read-row'

type Notice = { fence: number; clientMessageId: string; mailbox: string; messages: string[] }

/** Replayable projection, not a saved obligation: initial history once, then changed row keys only. */
export class StructuredNativeResponses {
  readonly recovery = new StructuredAccountRecovery()
  private readonly queued = new StructuredQueuedNativeResponses()
  private readonly signedOutFences = new Set<number>()
  private cursor: AgentJournalCursor | null = null
  private executionFence: number | undefined
  private readonly submissionKeys = new Map<string, string>()
  private readonly notices = new Map<string, Notice>()
  private readonly turns = new Map<string, Set<string>>()
  private readonly resolved = new Set<string>()
  private readonly pending = new Set<string>()
  private readonly noticesByUser = new Map<string, Set<string>>()

  read(
    journal: AgentSessionJournal,
    executionFence?: number
  ): {
    pending: Iterable<string>
    disposed: ReadonlySet<string>
  } {
    const next = journal.cursor()
    const fenceChanged = this.executionFence !== executionFence
    if (
      !fenceChanged &&
      this.cursor?.epoch === next.epoch &&
      this.cursor.sequence === next.sequence
    ) {
      return this.result()
    }
    const changes = this.cursor ? journal.readSince(this.cursor) : null
    if (!changes?.ok) {
      this.recovery.reset()
      this.signedOutFences.clear()
      this.submissionKeys.clear()
      this.notices.clear()
      this.turns.clear()
      this.resolved.clear()
      this.pending.clear()
      this.noticesByUser.clear()
      for (const submission of journal.submissions()) {
        this.observeSubmission(journal, submission.clientMessageId)
      }
      journal.visitItemsWithLinkage((id, _sequence, body, item) =>
        this.observe(journal, id, body, item)
      )
      this.queued.reset(journal)
    } else {
      for (const row of changes.rows) {
        if (row.kind === 'outcome') {
          this.changedOutcome(journal, row)
        } else {
          this.changed(journal, row)
        }
      }
      if (changes.rows.some(rewritesHistory)) {
        this.recovery.reset()
        for (const submission of journal.submissions()) {
          this.recovery.submission(submission)
        }
        journal.visitItemsWithLinkage((id) => {
          const item = journal.item(id)
          if (item) {
            this.recovery.item(journal, item)
          }
        })
      }
    }
    if (executionFence !== undefined && (fenceChanged || !changes?.ok)) {
      this.disposeEndedExecution(journal, executionFence)
    }
    this.executionFence = executionFence
    this.recovery.ready()
    this.cursor = next
    return this.result()
  }

  private changed(journal: AgentSessionJournal, row: JournalRow): void {
    this.queued.changed(journal, row)
    if (row.kind === 'submission' || row.kind === 'dispatch') {
      this.observeSubmission(journal, row.clientMessageId)
    } else if (row.kind === 'item' || row.kind === 'tombstone') {
      if (row.kind === 'tombstone' && row.retireSubmission) {
        const identity = parseAgentJournalItemKey(row.itemId)
        if (identity?.provider === 'orca') {
          this.disposeNotice(identity.clientMessageId)
        }
      }
      this.observeKey(journal, row.itemId)
    } else if (row.kind === 'lifecycle-batch') {
      for (const mutation of row.mutations) {
        this.observeKey(journal, mutation.itemId)
      }
    }
  }

  /** An outcome sequence names touched keys; each is re-read at its current value, as typed rows were. */
  private changedOutcome(journal: AgentSessionJournal, row: JournalOutcomeReadRow): void {
    for (const id of row.queueCardIds) {
      this.queued.changedCard(journal, id)
    }
    for (const clientMessageId of row.submissionIds) {
      // Only a rewind retiring an Orca send deletes a submission: the typed tombstone's retireSubmission.
      if (row.deleted.submissionIds.includes(clientMessageId)) {
        this.disposeNotice(clientMessageId)
      } else {
        this.observeSubmission(journal, clientMessageId)
      }
    }
    for (const itemId of row.itemIds) {
      this.observeKey(journal, itemId)
    }
  }

  private observeKey(journal: AgentSessionJournal, key: string): void {
    const item = journal.item(journal.canonicalItemId(key))
    if (item) {
      const clientMessageId = this.submissionKeys.get(journal.canonicalItemId(key))
      if (clientMessageId) {
        this.observeSubmission(journal, clientMessageId)
      }
      this.observe(journal, key, item.body, item)
    }
  }

  private observe(
    journal: AgentSessionJournal,
    key: string,
    body: AgentJournalItemBody,
    item: Pick<AgentJournalRenderItem, 'agentId'>
  ): void {
    if (!isRootAgentJournalItem(item)) {
      return
    }
    const rendered = journal.item(journal.canonicalItemId(key))
    if (rendered) {
      this.recovery.item(journal, rendered)
    }
    if (
      body.kind === 'status' &&
      readWholeAgentSessionFailureFact(body.failure)?.kind === 'notSignedIn'
    ) {
      const fence = journal.itemFence(key)
      if (fence !== undefined) {
        this.signedOutFences.add(fence)
      }
    }
    if (isAgentSessionContextClear(body) && body.kind === 'status' && body.contextClear) {
      for (const notice of this.notices.values()) {
        if (notice.fence <= body.contextClear.afterFence) {
          for (const message of notice.messages) {
            this.resolved.add(message)
            this.pending.delete(message)
          }
          this.notices.delete(notice.clientMessageId)
        }
      }
    }
    const source = body.kind === 'message' ? body.from?.orchestration : undefined
    if (source?.message === 'mail-notice') {
      const clientMessageId = this.submissionKeys.get(journal.canonicalItemId(key))
      if (clientMessageId) {
        this.notices.set(clientMessageId, {
          clientMessageId,
          fence: identityFence(journal, clientMessageId),
          mailbox: source.mailbox,
          messages: source.messages.map((message) => message.messageId)
        })
        this.observeSubmission(journal, clientMessageId)
      }
    }
    const turn = readAgentJournalTurn(body)
    if (turn?.userItemId) {
      const user = journal.canonicalItemId(turn.userItemId)
      const keys = this.turns.get(user) ?? new Set<string>()
      keys.add(key)
      this.turns.set(user, keys)
      for (const clientMessageId of this.noticesByUser.get(user) ?? []) {
        this.observeSubmission(journal, clientMessageId)
      }
    }
  }

  private observeSubmission(journal: AgentSessionJournal, clientMessageId: string): void {
    const submission = journal.submission(clientMessageId)
    this.recovery.submission(submission)
    const rendered = journal.item(
      journal.canonicalItemId(agentJournalSubmissionKey(clientMessageId))
    )
    if (rendered) {
      this.recovery.item(journal, rendered)
    }
    if (
      submission?.dispatchState === 'rejected' &&
      readWholeAgentSessionFailureFact(submission.rejection)?.kind === 'notSignedIn'
    ) {
      this.signedOutFences.add(submission.fence)
    }
    this.submissionKeys.set(
      journal.canonicalItemId(agentJournalSubmissionKey(clientMessageId)),
      clientMessageId
    )
    const body = journal.itemBody(agentJournalSubmissionKey(clientMessageId))
    const source = body?.kind === 'message' ? body.from?.orchestration : undefined
    if (source?.message === 'mail-notice' && !this.notices.has(clientMessageId)) {
      this.notices.set(clientMessageId, {
        clientMessageId,
        fence: identityFence(journal, clientMessageId),
        mailbox: source.mailbox,
        messages: source.messages.map((message) => message.messageId)
      })
    }
    const notice = this.notices.get(clientMessageId)
    if (!notice || !submission) {
      return
    }
    const user = journal.canonicalItemId(agentJournalSubmissionKey(clientMessageId))
    const clients = this.noticesByUser.get(user) ?? new Set<string>()
    clients.add(clientMessageId)
    this.noticesByUser.set(user, clients)
    for (const message of notice.messages) {
      if (!this.resolved.has(message)) {
        this.pending.add(message)
      }
    }
    const terminal = [...(this.turns.get(user) ?? [])].some((key) => {
      const turn = readAgentJournalTurn(journal.itemBody(key) ?? undefined)
      // Ending this exact turn disposes its account ownership, without claiming unknown/failed output succeeded.
      return turn !== null && turn.state !== 'running'
    })
    if (
      terminal ||
      submission.dispatchState === 'rejected' ||
      (submission.dispatchState === 'unknown' && submission.recovered === true)
    ) {
      for (const message of notice.messages) {
        this.resolved.add(message)
        this.pending.delete(message)
      }
      clients.delete(clientMessageId)
      this.notices.delete(clientMessageId)
    }
  }

  /** Ended generations keep main's handed-over/no-reply disposition; unhanded input still owns a future response. */
  private disposeEndedExecution(journal: AgentSessionJournal, fence: number): void {
    for (const notice of this.notices.values()) {
      const submission = journal.submission(notice.clientMessageId)
      if (submission && submission.fence !== fence && !isQueuedAgentJournalSubmission(submission)) {
        this.disposeNotice(notice.clientMessageId)
      }
    }
  }

  private disposeNotice(clientMessageId: string): void {
    const notice = this.notices.get(clientMessageId)
    for (const message of notice?.messages ?? []) {
      this.resolved.add(message)
      this.pending.delete(message)
    }
    this.notices.delete(clientMessageId)
  }

  signedOut(fence: number): boolean {
    return this.signedOutFences.has(fence)
  }

  private result() {
    return {
      pending: this.queued.pendingWith(this.pending, this.resolved),
      disposed: this.resolved
    }
  }
}

function identityFence(journal: AgentSessionJournal, clientMessageId: string): number {
  return journal.submission(clientMessageId)?.fence ?? 0
}

/** Provider history was rewritten: a tombstone outside Stop/resume marks, or an outcome sequence that deleted an item. */
function rewritesHistory(row: JournalReadRow): boolean {
  if (row.kind === 'outcome') {
    return row.deleted.itemIds.length > 0
  }
  return (
    (row.kind === 'tombstone' && !isJournalStopOrResumeRow(row)) ||
    (row.kind === 'lifecycle-batch' && row.mutations.some((item) => item.kind === 'tombstone'))
  )
}
