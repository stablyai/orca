import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createMobileRelayPairingFixtures,
  encodePairingFixturePayload
} from '../../../src/shared/mobile-relay-pairing-fixtures'
import { decodePairingUrl } from './pairing'

describe('mobile relay pairing contract', () => {
  const now = Date.UTC(2026, 6, 12, 16)

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(now)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  for (const fixture of createMobileRelayPairingFixtures(now)) {
    it(fixture.name, () => {
      expect(decodePairingUrl(encodePairingFixturePayload(fixture.payload))).toEqual(
        fixture.expected
      )
    })
  }
})
