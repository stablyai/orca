import { describe, expect, it } from 'vitest'
import { LegacyRelayPublicationLedger } from './legacy-relay-publication-ledger'

describe('LegacyRelayPublicationLedger', () => {
  it('caps each client and aggregate retained bytes', () => {
    const ledger = new LegacyRelayPublicationLedger({
      clientHighBytes: 10,
      clientLowBytes: 4,
      relayHighBytes: 15,
      relayLowBytes: 8
    })
    const first = ledger.tryReserve([
      { clientKey: 'a', bytes: 7 },
      { clientKey: 'b', bytes: 7 }
    ])
    expect(first).not.toBeNull()
    expect(ledger.retainedBytes).toBe(14)
    expect(ledger.tryReserve([{ clientKey: 'a', bytes: 4 }])).toBeNull()
    expect(ledger.tryReserve([{ clientKey: 'c', bytes: 2 }])).toBeNull()

    first?.[0].release()
    expect(ledger.retainedBytes).toBe(7)
    expect(ledger.tryReserve([{ clientKey: 'c', bytes: 2 }])).not.toBeNull()
  })

  it('releases leases exactly once and applies both low waters', () => {
    const ledger = new LegacyRelayPublicationLedger({
      clientHighBytes: 10,
      clientLowBytes: 3,
      relayHighBytes: 20,
      relayLowBytes: 5
    })
    const leases = ledger.tryReserve([
      { clientKey: 'a', bytes: 4 },
      { clientKey: 'b', bytes: 4 }
    ])
    expect(ledger.belowLowWater()).toBe(false)

    leases?.[0].release()
    leases?.[0].release()
    expect(ledger.retainedBytes).toBe(4)
    expect(ledger.belowLowWater()).toBe(false)

    leases?.[1].release()
    expect(ledger.retainedBytes).toBe(0)
    expect(ledger.belowLowWater()).toBe(true)
  })
})
