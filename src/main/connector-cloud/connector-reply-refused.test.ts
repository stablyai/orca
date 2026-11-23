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

/** Whether the row goes again under the same hello, and under the next, after the cloud refused
 *  it with `failure`. */
async function sentAgainAfter(
  failure: ConnectorFailure
): Promise<{ sameHello: boolean; nextHello: boolean }> {
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
    post: async () => failure,
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
  // A new hello (the reply route may have changed) gives it another chance.
  events.resetLive()
  await events.drainReplies()
  const nextHello = events.next(2)?.batch.some((event) => event.kind === 'reply') === true
  events.clear()
  return { sameHello, nextHello }
}

it('holds a reply refused as invalid until the next hello, and keeps sending one that does not stand yet', async () => {
  expect(await sentAgainAfter(refusal(400, 'invalid_request'))).toEqual({
    sameHello: false,
    nextHello: true
  })
  expect(await sentAgainAfter(refusal(503, 'reply_not_accepted'))).toEqual({
    sameHello: true,
    nextHello: true
  })
})
