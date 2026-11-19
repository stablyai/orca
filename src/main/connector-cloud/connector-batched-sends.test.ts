import { describe, expect, it, vi } from 'vitest'
import {
  ConnectorDelivery,
  type ConnectorAsker
} from '../../shared/connectors/connector-cloud-contract'
import type { ExternalConversationHost } from '../external-conversations/external-conversation-host'
import type { ExternalConversationSeam } from '../external-conversations/external-conversation-seam'
import type { RequestDelivery, SendDelivery } from './connector-deliveries'
import { connectorDeliveryUnits, dispatchBatch } from './connector-delivery-batches'

// Messages that piled up in one thread while the Mac slept, handed out together once it woke.
const NOW = 2_000_000_000_000
const EXPIRES_AT = NOW + 60 * 60_000
const HOUR = 60 * 60_000
const conversation = {
  source: 'slack' as const,
  externalId: 'T0TEAM:C0FEED:1700000000.000100:U0BOT'
}
const other = { source: 'slack' as const, externalId: 'T0TEAM:C0FEED:1700000999.000100:U0BOT' }
const botPlace = Buffer.from(JSON.stringify(['bot', 'bot-1'])).toString('base64url')
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake seam never reads the host.
const host = {} as ExternalConversationHost
const asker = (userId: string, text: string): ConnectorAsker => ({
  userId,
  role: userId === 'U0DANA' ? 'owner' : 'member',
  place: { kind: 'channel', id: 'C0FEED' },
  text,
  context: []
})
const msLeft = (expiresAt: number) => expiresAt - NOW

function request(raw: unknown): RequestDelivery {
  const delivery = ConnectorDelivery.parse(raw)
  if (delivery.kind !== 'start' && delivery.kind !== 'send') {
    throw new Error('not a request')
  }
  return delivery
}

function start(deliveryId: string, text: string, userId = 'U0DANA', askedAt = NOW - 9 * HOUR) {
  return request({
    kind: 'start',
    deliveryId,
    expiresAt: EXPIRES_AT,
    conversation,
    agent: 'claude',
    placeId: botPlace,
    prompt: text,
    asker: asker(userId, text),
    askedAt
  })
}

function send(
  deliveryId: string,
  text: string,
  { userId = 'U0DANA', askedAt = NOW - 7 * HOUR, at = conversation } = {}
): SendDelivery {
  const delivery = request({
    kind: 'send',
    deliveryId,
    expiresAt: EXPIRES_AT,
    conversation: at,
    text,
    asker: asker(userId, text),
    askedAt
  })
  if (delivery.kind !== 'send') {
    throw new Error('not a send')
  }
  return delivery
}

const ids = (units: ReturnType<typeof connectorDeliveryUnits>) =>
  units.map((unit) =>
    'raw' in unit
      ? ConnectorDelivery.parse(unit.raw).deliveryId
      : unit.batch.map((delivery) => delivery.deliveryId)
  )

describe('a thread’s messages that waited together', () => {
  it('group behind their first, by thread and person, keeping each thread’s order', () => {
    const units = connectorDeliveryUnits(
      [
        start('a1', 'review this'),
        send('b1', 'other thread', { at: other }),
        send('a2', 'never mind, only the docs'),
        send('a3', 'from Sam', { userId: 'U0SAM' }),
        send('a4', 'and Dana again')
      ],
      () => false
    )
    expect(ids(units)).toEqual([['a1', 'a2'], ['b1'], ['a3'], ['a4']])
  })

  it('leave a delivery this machine already holds or ran on its own, so it replays', () => {
    const units = connectorDeliveryUnits(
      [start('a1', 'review this'), send('a2', 'and this'), send('a3', 'and that')],
      (delivery) => delivery.deliveryId === 'a1'
    )
    expect(ids(units)).toEqual(['a1', ['a2', 'a3']])
  })

  it('run as one turn whose later messages settle as it does', async () => {
    let finish: (outcome: { outcome: 'accepted' }) => void = () => {}
    const turn = new Promise<{ outcome: 'accepted' }>((resolve) => (finish = resolve))
    type Input = {
      prompt: string
      sent?: { askedAt: number; waitedMs: number }
      later?: { text: string; sent?: { askedAt: number; waitedMs: number } }[]
    }
    const seamStart = vi.fn(async (_host: unknown, _key: unknown, _id: string, _input: Input) => ({
      conversation: { worktreeId: 'w', sessionId: 's' },
      initial: await turn
    }))
    const carried = vi.fn(
      async (_key: unknown, _id: string, _text: string, done: Promise<unknown>) => await done
    )
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a batch calls only start and its receipts.
    const seam = { start: seamStart, receipts: { carried } } as unknown as ExternalConversationSeam
    const batch: [RequestDelivery, SendDelivery] = [
      start('a1', 'review this'),
      send('a2', 'never mind, only the docs')
    ]
    const dispatched = dispatchBatch(seam, host, { runTrigger: async () => false }, batch, msLeft)
    expect(dispatched.map((each) => [each.deliveryId, each.received])).toEqual([
      ['a1', true],
      ['a2', true]
    ])
    expect(seamStart).toHaveBeenCalledTimes(1)
    const input = seamStart.mock.calls[0]?.[3]
    expect(input?.sent).toEqual({ askedAt: NOW - 9 * HOUR, waitedMs: 9 * HOUR })
    expect(input?.later).toEqual([
      expect.objectContaining({
        text: 'never mind, only the docs',
        sent: { askedAt: NOW - 7 * HOUR, waitedMs: 7 * HOUR }
      })
    ])
    expect(carried).toHaveBeenCalledWith(
      conversation,
      'a2',
      'never mind, only the docs',
      expect.any(Promise)
    )
    finish({ outcome: 'accepted' })
    expect(await Promise.all(dispatched.map((each) => each.done))).toEqual([
      { outcome: 'accepted' },
      { outcome: 'accepted' }
    ])
  })

  it('refuse a later message past its deadline on its own, as any delivery would be', () => {
    const seamStart = vi.fn(async () => ({
      conversation: { worktreeId: 'w', sessionId: 's' },
      initial: { outcome: 'accepted' as const }
    }))
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a batch calls only start and its receipts.
    const seam = {
      start: seamStart,
      receipts: { carried: vi.fn() }
    } as unknown as ExternalConversationSeam
    const late = { ...send('a2', 'late'), expiresAt: NOW + 1_000 }
    const dispatched = dispatchBatch(
      seam,
      host,
      { runTrigger: async () => false },
      [start('a1', 'review this'), late],
      msLeft
    )
    expect(dispatched.map((each) => [each.deliveryId, each.received])).toEqual([
      ['a1', true],
      ['a2', false]
    ])
  })
})
