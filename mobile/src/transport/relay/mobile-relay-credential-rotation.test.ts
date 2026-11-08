import { describe, expect, it, vi } from 'vitest'

import { applyResumeConfirmation } from './mobile-relay-credential-rotation'
import type { MobileRelayCredentialBundle } from '../mobile-relay-credential-bundle'

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))
vi.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'when-unlocked' }))
vi.mock('expo-crypto', () => ({ getRandomBytes: (length: number) => new Uint8Array(length) }))

const bundle: MobileRelayCredentialBundle = {
  v: 1,
  hostId: 'host-1',
  deviceToken: 'device-token',
  current: {
    token: 'A'.repeat(43),
    hash: 'B'.repeat(43),
    version: 2,
    expiresAt: 50_000
  }
}

describe('mobile relay credential rotation', () => {
  it('applies only authoritative current or grace confirmation expiries', () => {
    const withGrace: MobileRelayCredentialBundle = {
      ...bundle,
      grace: { token: 'C'.repeat(43), hash: 'D'.repeat(43), version: 1, expiresAt: 40_000 }
    }
    const renewed = applyResumeConfirmation(withGrace, 2, {
      v: 1,
      reqId: 'confirm-current',
      currentVersion: 2,
      acceptedAs: 'current',
      renewed: true,
      resumeExpiresAt: 120_000,
      graceExpiresAt: 40_000
    })
    const grace = applyResumeConfirmation(renewed, 1, {
      v: 1,
      reqId: 'confirm-grace',
      currentVersion: 2,
      acceptedAs: 'grace',
      renewed: false,
      resumeExpiresAt: 120_000,
      graceExpiresAt: 45_000
    })

    expect(renewed.current.expiresAt).toBe(120_000)
    expect(grace.grace?.expiresAt).toBe(45_000)
    expect(applyResumeConfirmation(grace, 99, { ...graceConfirmation(), reqId: 'other' })).toBe(
      grace
    )
  })
})

function graceConfirmation() {
  return {
    v: 1 as const,
    reqId: 'confirm',
    currentVersion: 2,
    acceptedAs: 'grace' as const,
    renewed: false,
    resumeExpiresAt: 120_000,
    graceExpiresAt: 45_000
  }
}
