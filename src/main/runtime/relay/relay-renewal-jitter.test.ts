import { describe, expect, it } from 'vitest'
import {
  RELAY_RENEWAL_JITTER_RATIO,
  RELAY_RENEWAL_SAFETY_MARGIN_MS,
  relayRenewalDelayMs
} from './relay-renewal-jitter'

const LEASE_MS = 55 * 60_000
const latest = LEASE_MS - RELAY_RENEWAL_SAFETY_MARGIN_MS
const base = latest / (1 + RELAY_RENEWAL_JITTER_RATIO)

describe('relay renewal jitter', () => {
  it('keeps every sample inside the jitter band and before the safety margin', () => {
    let seed = 1
    const random = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed / 2147483648
    }
    const samples: number[] = []
    for (let i = 0; i < 20_000; i++) {
      samples.push(relayRenewalDelayMs(LEASE_MS, 0, random))
    }
    for (const sample of samples) {
      expect(sample).toBeGreaterThanOrEqual(Math.floor(base * (1 - RELAY_RENEWAL_JITTER_RATIO)))
      expect(sample).toBeLessThanOrEqual(latest)
      // The renewal never lands inside the margin, so it never races expiry.
      expect(LEASE_MS - sample).toBeGreaterThanOrEqual(RELAY_RENEWAL_SAFETY_MARGIN_MS)
    }
    const mean = samples.reduce((total, sample) => total + sample, 0) / samples.length
    expect(Math.abs(mean - base) / base).toBeLessThan(0.005)
  })

  it('spreads a same-second cohort over minutes instead of one second', () => {
    const delays = Array.from({ length: 1000 }, (_, index) =>
      relayRenewalDelayMs(LEASE_MS, 0, () => index / 999)
    )
    const spread = Math.max(...delays) - Math.min(...delays)
    expect(spread).toBeGreaterThan(9 * 60_000)
  })

  it('pins the band ends to the base interval', () => {
    expect(relayRenewalDelayMs(LEASE_MS, 0, () => 0)).toBe(
      Math.floor(base * (1 - RELAY_RENEWAL_JITTER_RATIO))
    )
    expect(relayRenewalDelayMs(LEASE_MS, 0, () => 0.5)).toBe(Math.floor(base))
    expect(relayRenewalDelayMs(LEASE_MS, 0, () => 1)).toBe(latest)
  })

  it('renews immediately once the lease is inside the safety margin', () => {
    expect(relayRenewalDelayMs(RELAY_RENEWAL_SAFETY_MARGIN_MS, 0, () => 1)).toBe(0)
    expect(relayRenewalDelayMs(0, 60_000, () => 1)).toBe(0)
  })

  it('measures the delay from now, not from the epoch', () => {
    expect(relayRenewalDelayMs(LEASE_MS + 1_000_000, 1_000_000, () => 0.5)).toBe(Math.floor(base))
  })
})
