import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { CONNECTOR_REPLIES_OUTBOX_FEATURE } from '../../shared/connectors/connector-cloud-contract'
import type { JournalConnectorReplyRow } from '../../shared/agent-session/journal/journal-connector-reply'
import type { ConnectorFailure } from './connector-cloud-request'
import { ConnectorTurnEvents } from './connector-turn-events'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })))

const row: JournalConnectorReplyRow = {
  account: 'ada',
  deliveryId: 'd1',
  conversation: { source: 'slack', externalId: 'T0TEAM:C0CHANNEL:1.0:U0BOT' },
  sessionId: 'chat-1',
  epoch: 'e',
  messageId: 'm1',
  queued: false,
  fill: { outcome: 'answered', answerDeliveryId: 'd1', prose: 'The fix is in.', filledAt: 1 }
}

const refusal = (status: number, error: string): ConnectorFailure => ({
  ok: false,
  status,
  error,
  retryAfterMs: null
})

/** Whether the row goes again under the same hello, and how often it is posted under a next hello
 *  that switched to the /replies route, after the cloud refused it with `failure`. */
async function sentAgainAfter(
  failure: ConnectorFailure
): Promise<{ sameHello: boolean; postedNext: number }> {
  let posted = 0
  const dir = mkdtempSync(join(tmpdir(), 'orca-reply-refused-'))
  dirs.push(dir)
  const events = new ConnectorTurnEvents(dir, 'ada', undefined, {
    journal: () => ({
      read: async () => [row],
      readOwed: async (_account, after) => (after === null ? [row] : []),
      fillOutcomes: async () => false,
      sent: async () => {}
    }),
    onOwed: () => {},
    post: async () => {
      posted += 1
      return { ok: true, value: {} }
    },
    hostName: () => 'laptop'
  })
  events.useCloudFeatures(new Set([CONNECTOR_REPLIES_OUTBOX_FEATURE]))
  events.useReplyFlush(() => {})
  await events.drainReplies()
  const head = events.next(1)
  expect(head?.batch.map((event) => event.kind)).toEqual(['reply'])
  events.refused(head!.stamp, failure)
  await events.drainReplies()
  const sameHello = events.next(1) !== null
  // A new hello, here one that switched replies to /replies, gives it another chance.
  events.useCloudFeatures(new Set())
  events.resetLive()
  await events.drainReplies()
  events.clear()
  return { sameHello, postedNext: posted }
}

it('holds a reply refused as invalid until the next hello, and keeps sending one that does not stand yet', async () => {
  expect(await sentAgainAfter(refusal(400, 'invalid_request'))).toEqual({
    sameHello: false,
    postedNext: 1
  })
  expect(await sentAgainAfter(refusal(503, 'reply_not_accepted'))).toEqual({
    sameHello: true,
    postedNext: 1
  })
})

it('loads the next journal page only once the outbox accepts the current page', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orca-reply-pages-'))
  dirs.push(dir)
  const rows = Array.from({ length: 201 }, (_, index): JournalConnectorReplyRow => {
    const deliveryId = `d${String(index).padStart(3, '0')}`
    return {
      ...row,
      deliveryId,
      fill: { ...row.fill!, answerDeliveryId: deliveryId }
    }
  })
  const sent = new Set<string>()
  let reads = 0
  const events = new ConnectorTurnEvents(dir, 'ada', undefined, {
    journal: () => ({
      read: async () => rows,
      readOwed: async (_account, after, limit) => {
        reads += 1
        return rows
          .filter(({ deliveryId }) => !sent.has(deliveryId) && (!after || deliveryId > after))
          .slice(0, limit)
      },
      fillOutcomes: async () => false,
      sent: async (keys) => keys.forEach(({ deliveryId }) => sent.add(deliveryId))
    }),
    onOwed: () => {},
    post: async () => ({ ok: true, value: {} }),
    hostName: () => 'laptop'
  })
  try {
    events.useCloudFeatures(new Set([CONNECTOR_REPLIES_OUTBOX_FEATURE]))
    events.useReplyFlush(() => {})
    await events.drainReplies()
    await events.drainReplies()
    expect(reads).toBe(1)
    while (sent.size < 200) {
      const head = events.next(1)
      expect(head).not.toBeNull()
      events.accepted(head!.stamp)
      await events.drainReplies()
    }
    expect(reads).toBe(2)
    expect(events.next(1)?.batch).toMatchObject([{ kind: 'reply', answerDeliveryId: 'd200' }])
  } finally {
    events.clear()
  }
})
