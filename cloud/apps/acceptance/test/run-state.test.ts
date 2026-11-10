import { describe, expect, it } from 'vitest'
import { CATALOG } from '../src/catalog'
import { pairingKey } from '../src/checks/core'
import { percentile } from '../src/run-state'
import { resourceCost } from '../src/report'

describe('percentile (nearest rank)', () => {
  it('handles empty, odd and even sample counts', () => {
    expect(percentile([], 50)).toBeNull()
    expect(percentile([5, 1, 3], 50)).toBe(3)
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50)).toBe(5)
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10)
  })
})

describe('resourceCost', () => {
  it('bills sandboxes by vCPU x running time and ignores other kinds', () => {
    const hour = 3_600_000
    const cost = resourceCost([
      { kind: 'sandbox', id: 'a', vcpus: 4, runningMs: hour, createdAt: '2026-11-09T00:00:00Z', destroyedAt: '2026-11-09T01:00:00Z' },
      { kind: 'stripe_customer', id: 'cus_1', createdAt: '2026-11-09T00:00:00Z' }
    ])
    expect(cost.vcpuHours).toBe(4)
    expect(cost.usd).toBeCloseTo(4 * (0.128 + 2 * 0.0106), 6)
  })
})

describe('pairingKey', () => {
  it('reads the host public key from an orca://pair code and tolerates garbage', () => {
    const payload = Buffer.from(JSON.stringify({ v: 2, publicKeyB64: 'abc' })).toString('base64url')
    expect(pairingKey(`orca://pair?code=${payload}`)).toBe('abc')
    expect(pairingKey('not a url')).toBeNull()
  })
})

describe('catalog', () => {
  it('has unique ids', () => {
    expect(new Set(CATALOG.map((f) => f.id)).size).toBe(CATALOG.length)
  })
})
