import { randomUUID } from 'node:crypto'
import type {
  NativeChatTerminalActivity,
  NativeChatTerminalQueueSnapshot
} from '../../shared/native-chat/native-chat-terminal-queue'
import {
  QUEUED_MESSAGE_PAUSED_SEND_FAILED,
  type AgentSessionQueuedMessage
} from '../../shared/agent-session/requests/agent-session-queued-message-wire'
import type { AgentSessionJournal } from './agent-session-journal/journal-store'
import type { QueuedMessageRow } from './agent-session-journal/queued-messages/queued-message-table'
import { agentSessionFailureFact } from '../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../shared/agent-session/failures/agent-session-failure-words'
import { queuedMessagesPublishedBytesRefusal } from './agent-session-wire/delivery/structured-agent-session-queued-published-bytes'
import type { AgentJournalMessageItem } from '../../shared/agent-session/journal/agent-session-journal-types'

/** Waiting and returned rows only. A hold publishes as paused so a later card cannot pass it. */
function publishedQueuedMessages(rows: readonly QueuedMessageRow[]): AgentSessionQueuedMessage[] {
  const published: AgentSessionQueuedMessage[] = []
  for (const row of rows) {
    if (row.state !== 'waiting' && row.state !== 'returned') {
      continue
    }
    const held = row.state === 'waiting' && row.holdReason !== null
    published.push({
      messageId: row.messageId,
      position: row.position,
      body: row.body,
      state: row.state,
      ...(held ? { paused: true as const } : {}),
      ...(held && row.holdReason === QUEUED_MESSAGE_PAUSED_SEND_FAILED
        ? { pausedReason: row.holdReason }
        : {}),
      ...(row.state === 'returned' ? { returnedReason: row.returnedReason } : {}),
      ...(row.state === 'returned' && row.returnedRejection
        ? { returnedRejection: row.returnedRejection }
        : {})
    })
  }
  return published
}

export class TerminalChatQueue {
  private draining: Promise<void> | null = null
  private submittedSequence: number | null = null
  private admissions: Promise<void> = Promise.resolve()
  private published: readonly AgentSessionQueuedMessage[] = []
  private revision = '0:0'

  constructor(
    readonly journal: AgentSessionJournal,
    private readonly activity: () => NativeChatTerminalActivity,
    private readonly send: (text: string) => Promise<boolean>
  ) {}

  snapshot(): NativeChatTerminalQueueSnapshot {
    return {
      revision: this.revision,
      activity: this.activity(),
      queuedMessages: this.published
    }
  }

  enqueue(messageId: string, text: string): Promise<void> {
    const flight = this.admissions.then(() => this.enqueueOne(messageId, text))
    this.admissions = flight.catch(() => {})
    return flight
  }

  private async enqueueOne(messageId: string, text: string): Promise<void> {
    const existing = await this.journal.queuedMessages.get(messageId)
    if (existing) {
      const blocks = existing.body.kind === 'message' ? existing.body.blocks : []
      if (blocks.some((block) => block.type === 'text' && block.text !== text)) {
        throw new Error('terminal_chat_queue_payload_changed')
      }
      return
    }
    const published = publishedQueuedMessages(await this.journal.queuedMessages.list())
    if (published.length >= 100) {
      throw new Error('terminal_chat_queue_full')
    }
    const body: AgentJournalMessageItem = {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text }]
    }
    const refusal = await queuedMessagesPublishedBytesRefusal(this.journal, body, true)
    if (refusal) {
      throw new Error(refusal.message)
    }
    await this.journal.queuedMessages.insert({ messageId, body })
    await this.rememberPublished()
  }

  drain(): Promise<void> {
    if (this.draining) {
      return this.draining
    }
    const flight = this.drainOne().finally(() => {
      if (this.draining === flight) {
        this.draining = null
      }
    })
    this.draining = flight
    return flight
  }

  async cancel(messageIds: string[]): Promise<void> {
    const head = publishedQueuedMessages(await this.journal.queuedMessages.list())[0]
    await this.journal.queuedMessages.withdraw(messageIds)
    if (head?.paused && messageIds.includes(head.messageId)) {
      this.submittedSequence = null
    }
    await this.rememberPublished()
  }

  private async drainOne(): Promise<void> {
    try {
      const first = publishedQueuedMessages(await this.journal.queuedMessages.list())[0]
      if (!first || first.paused || first.state !== 'waiting') {
        return
      }
      const activity = this.activity()
      if (
        activity.state !== 'idle' ||
        !activity.inputReady ||
        (this.submittedSequence !== null && activity.workingSequence <= this.submittedSequence)
      ) {
        return
      }
      const card = await this.journal.queuedMessages.get(first.messageId)
      if (!card || card.state !== 'waiting' || card.holdReason !== null) {
        return
      }
      const id = randomUUID()
      await this.journal.appendSubmission(
        {
          clientMessageId: id,
          payloadFingerprint: card.fingerprint,
          body: card.body,
          fence: 0,
          handoverRecorded: true,
          origin: 'host'
        },
        { messageId: card.messageId, expect: 'waiting' }
      )
      this.submittedSequence = activity.workingSequence
      const text = card.body.blocks
        .flatMap((block) => (block.type === 'text' ? [block.text] : []))
        .join('\n')
      const sent = await this.send(text).catch(() => null)
      if (sent === true) {
        await this.journal.resolveDispatch({
          clientMessageId: id,
          state: 'accepted',
          providerIdentity: null,
          fence: 0
        })
        return
      }
      // Unconfirmed is not a failure verdict, so a recorded handover returns the card to waiting.
      // A false write never reached the PTY and retries; a throw may have landed, so it stays paused.
      await this.journal.resolveDispatch({
        clientMessageId: id,
        state: 'rejected',
        fence: 0,
        ...agentSessionFailureWords(agentSessionFailureFact('unconfirmed'), {
          surface: 'rejection'
        })
      })
      if (sent === false) {
        this.submittedSequence = null
        return
      }
      await this.journal.queuedMessages.hold({
        messageIds: [card.messageId],
        reason: QUEUED_MESSAGE_PAUSED_SEND_FAILED
      })
    } finally {
      await this.rememberPublished()
    }
  }

  private async rememberPublished(): Promise<void> {
    const cursor = this.journal.cursor()
    this.revision = `${cursor.epoch}:${cursor.sequence}`
    this.published = publishedQueuedMessages(await this.journal.queuedMessages.list())
  }
}
