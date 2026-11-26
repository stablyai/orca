import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { runProcess } from '@orca/process-host'
import { FeishuInbox } from './feishu-inbox'
import type { FeishuStore } from './feishu-store-ops'
import { FeishuCardDelivery } from './feishu-card-delivery'
import { drainFeishuTextOutbox } from './feishu-text-outbox'
import { drainFeishuOutbox } from './feishu-outbox'
import { dmKey } from './feishu-binding'
import type { ConnectorReplyJournal } from '../connector-cloud/connector-reply-outbox'
import type { JournalConnectorReplyRow } from '../../shared/agent-session/journal/journal-connector-reply'

vi.mock('@orca/process-host', () => ({ runProcess: vi.fn() }))

it('isolates recalled replies across pages and restart, and does not mark failed final answers sent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'feishu-delivery-'))
  const path = join(dir, 'inbox.sqlite')
  let inbox = new FeishuInbox(path)
  const now = 1800000001000
  vi.spyOn(Date, 'now').mockReturnValue(now)
  const posted: string[] = []
  const attempts: string[] = []
  let transient = true
  vi.mocked(runProcess).mockImplementation(async ({ args }) => {
    const target = args?.find((arg) => arg.endsWith('/reply'))
    let code: number | null = null
    if (target) {
      attempts.push(target)
      if (target.includes('om_bad')) {
        code = 230011
      }
      if (target.includes('om_retry') && transient) {
        code = 230020
      }
      if (code === null) {
        posted.push(target)
      }
    }
    return {
      code: code === null ? 0 : 1,
      signal: null,
      outputTruncated: false,
      timedOut: false,
      stdout:
        code === null
          ? JSON.stringify({
              ok: true,
              identity: 'bot',
              data: {
                card_id: '12345',
                chat_id: 'oc_chat',
                message_id: `${target?.split('/')[5] ?? 'om_card'}_sent`
              }
            })
          : '',
      stderr:
        code === null ? '' : JSON.stringify({ ok: false, error: { code, message: 'redacted' } })
    }
  })
  const store: FeishuStore = {
    deliveryReady: async (...args) => inbox.deliveryReady(...args),
    deliveryFailed: async (...args) => inbox.deliveryFailed(...args),
    deliverySucceeded: async (...args) => inbox.deliverySucceeded(...args),
    deliveryRetrying: async (...args) => inbox.deliveryRetrying(...args),
    putRoute: async (...args) => inbox.putRoute(...args),
    messageRoute: async (...args) => inbox.messageRoute(...args),
    laneRoute: async (...args) => inbox.laneRoute(...args),
    putCard: async (...args) => inbox.putCard(...args),
    getCard: async (...args) => inbox.getCard(...args),
    replyMessage: async (...args) => inbox.replyMessage(...args),
    questionResponse: async (...args) => inbox.questionResponse(...args),
    questionContinuation: async (...args) => inbox.questionContinuation(...args),
    cardkit: async (...args) => inbox.cardkit(...args),
    cardSequence: async (...args) => inbox.cardSequence(...args),
    updateResponse: async (...args) => inbox.updateResponse(...args),
    pendingCards: async (...args) => inbox.pendingCards(...args),
    pendingChoice: async (...args) => inbox.pendingChoice(...args),
    claimCard: async (...args) => inbox.claimCard(...args),
    claimCardFor: async (...args) => inbox.claimCardFor(...args),
    closeCard: async (...args) => inbox.closeCard(...args),
    closePrompts: async (...args) => inbox.closePrompts(...args),
    sendingCard: async (...args) => inbox.sendingCard(...args),
    postedCard: async (...args) => inbox.postedCard(...args),
    bindings: async (...args) => inbox.bindings(...args),
    add: async (...args) => inbox.add(...args),
    remove: async (...args) => inbox.remove(...args),
    pair: async (...args) => inbox.pair(...args),
    accept: async (...args) => inbox.accept(...args),
    next: async (...args) => inbox.next(...args),
    sender: async (...args) => inbox.sender(...args),
    laneSender: async (...args) => inbox.laneSender(...args),
    stageFile: async (...args) => inbox.stageFile(...args),
    artifact: async (...args) => inbox.artifact(...args),
    uploaded: async (...args) => inbox.uploaded(...args),
    filePosted: async (...args) => inbox.filePosted(...args),
    takeProgress: async (...args) => inbox.takeProgress(...args),
    stored: async (...args) => inbox.stored(...args),
    admitted: async (...args) => inbox.admitted(...args),
    review: async (...args) => inbox.review(...args),
    needsReview: async (...args) => inbox.needsReview(...args),
    queueReply: async (...args) => inbox.queueReply(...args),
    pendingReplies: async (...args) => inbox.pendingReplies(...args),
    mayPostReply: async (...args) => inbox.mayPostReply(...args),
    replyPosted: async (...args) => inbox.replyPosted(...args),
    mayPost: async (...args) => inbox.mayPost(...args)
  }
  try {
    const initial = inbox.add('scope', 'bot', { name: 'p', appId: 'cli_app', brand: 'feishu' })
    const event = {
      type: 'im.message.receive_v1',
      chat_type: 'p2p',
      message_type: 'text',
      create_time: '1800000000000',
      event_id: 'pair',
      message_id: 'om_pair',
      chat_id: 'oc_chat',
      sender_id: 'ou_owner',
      content: 'Test'
    } as const
    inbox.pair('scope', initial, event)
    const [b] = inbox.bindings('scope')
    const conversation = dmKey(b)
    const mids = [
      ...Array.from({ length: 33 }, (_, i) => `om_bad${String(i).padStart(2, '0')}`),
      'om_retry',
      'om_zgood'
    ]
    for (const mid of mids) {
      inbox.accept(b, { ...event, create_time: '1800000000001', event_id: mid, message_id: mid })
      inbox.updateResponse(b.account, conversation.externalId, mid, 'oc_chat', { kind: 'begin' })
      inbox.queueReply(b.account, mid, mid, 'Progress')
    }
    const signal = new AbortController().signal
    let cards = new FeishuCardDelivery(store, b, signal, () => true)
    const drainText = () =>
      drainFeishuTextOutbox(
        store,
        b,
        () => true,
        async () => {},
        () => {},
        cards
      )
    await drainText()
    expect(posted).toEqual(['/open-apis/im/v1/messages/om_zgood/reply'])
    expect(attempts).toHaveLength(35)
    expect(inbox.deliveryRetrying(b.account)).toBe(true)
    expect(inbox.needsReview(b.account)).toBe(true)
    inbox.close()
    inbox = new FeishuInbox(path)
    cards = new FeishuCardDelivery(store, b, signal, () => true)
    await drainText()
    expect(attempts).toHaveLength(35)
    expect(inbox.deliveryReady(b.account, 'card:response:om_bad00', now + 3600000)).toBe(false)
    transient = false
    vi.mocked(Date.now).mockReturnValue(now + 16000)
    await drainText()
    expect(posted).toContain('/open-apis/im/v1/messages/om_retry/reply')
    expect(inbox.deliveryRetrying(b.account)).toBe(false)

    const owed: JournalConnectorReplyRow[] = ['om_bad00', 'om_zgood'].map((mid) => ({
      account: b.account,
      deliveryId: mid,
      conversation,
      sessionId: 'session',
      epoch: 'epoch',
      messageId: mid,
      queued: false,
      fill: { answerDeliveryId: mid, outcome: 'answered', prose: 'Final', filledAt: 1 }
    }))
    const sent: string[] = []
    const journal: ConnectorReplyJournal = {
      read: async () => owed,
      readOwed: async (_account, after, limit) =>
        owed.filter((r) => after === null || r.deliveryId > after).slice(0, limit),
      fillOutcomes: async () => false,
      sent: async (keys) => {
        sent.push(...keys.map((key) => key.deliveryId))
      }
    }
    await drainFeishuOutbox(
      journal,
      store,
      b,
      signal,
      () => true,
      async () => {},
      () => {},
      'Test',
      cards
    )
    expect(sent).toEqual(['om_zgood'])
    expect(attempts.filter((target) => target.includes('om_bad00'))).toHaveLength(1)
  } finally {
    vi.restoreAllMocks()
    inbox.close()
    await rm(dir, { recursive: true, force: true })
  }
})
