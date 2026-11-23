import { describe, expect, it } from 'vitest'
import { connectorDeliveryUnits } from './connector-delivery-batches'

const conversation = { source: 'slack', externalId: 'T1:C1:1800000000.000100:U0BOT' }
const send = (deliveryId: string, seq: number, extra: Record<string, unknown> = {}) => ({
  kind: 'send',
  deliveryId,
  seq,
  expiresAt: 1_900_000_000_000,
  conversation,
  text: 'look again',
  ...extra
})

describe('connectorDeliveryUnits', () => {
  // A resume's not_failed check guards only a turn it leads alone; joined to another send's turn,
  // or leading one others joined, its continue could run unchecked.
  it('never batches a resume with other sends', () => {
    const units = connectorDeliveryUnits(
      [send('a', 1), send('r', 2, { resume: { turnId: 1_800_000_001_000 } }), send('b', 3)],
      () => false
    )
    expect(
      units.map((unit) =>
        'batch' in unit
          ? unit.batch.map((delivery) => delivery.deliveryId)
          : (unit.raw as { deliveryId: string }).deliveryId
      )
    ).toEqual([['a'], 'r', ['b']])
  })
})
