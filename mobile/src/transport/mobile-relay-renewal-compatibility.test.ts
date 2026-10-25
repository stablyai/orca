import { describe, expect, it, vi } from 'vitest'
import type { DeviceResumeConfirmed } from '../../../src/shared/mobile-relay-credential-contract'
import type { MobileRelayCredentialBundle } from './mobile-relay-credential-bundle'
import { hashMobileRelayCredential } from './mobile-relay-credential-hash'
import {
  mobileRelayCredentialNeedsRotation,
  persistResumeConfirmation
} from './mobile-relay-credential-rotation'
import { RelayLeaseRotationTimer } from './mobile-relay-lease-rotation-timer'

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))
vi.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'when-unlocked' }))
vi.mock('expo-crypto', () => ({ getRandomBytes: (length: number) => new Uint8Array(length) }))

// Memory cells renew at most daily; current-version confirmations must still say renewed so shipped phones retain lease timers.
const DAY = 24 * 60 * 60 * 1000
const RESUME_TTL_MS = 30 * DAY
const RENEWAL_INTERVAL_MS = DAY
const TOKEN = 'A'.repeat(43)

// The memory cell's answer (cloud/apps/relay/src/credential-store.ts confirmMemoryResume).
function memoryCellConfirm(
  stored: { expiresAt: number; renewals: number },
  now: number,
  answerNotDue: 'renewed' | 'unchanged'
): DeviceResumeConfirmed {
  const due = stored.expiresAt < now + RESUME_TTL_MS - RENEWAL_INTERVAL_MS
  if (due) {
    stored.expiresAt = now + RESUME_TTL_MS
    stored.renewals += 1
  }
  return {
    v: 1,
    reqId: `confirm-${now}`,
    currentVersion: 2,
    acceptedAs: 'current',
    renewed: due || answerNotDue === 'renewed',
    resumeExpiresAt: stored.expiresAt
  }
}

// A phone whose only path is the relay: the lease timer's re-resume is its only renewal.
async function relayOnlyPhone(days: number, answerNotDue: 'renewed' | 'unchanged') {
  let now = Date.parse('2026-10-19T00:00:00Z')
  const stored = { expiresAt: now + RESUME_TTL_MS, renewals: 0 }
  let bundle: MobileRelayCredentialBundle = {
    v: 1,
    hostId: 'host-1',
    deviceToken: 'device-token',
    current: {
      token: TOKEN,
      hash: hashMobileRelayCredential(TOKEN),
      version: 2,
      expiresAt: stored.expiresAt
    }
  }
  const slot: { delayMs: number | null } = { delayMs: null }
  const timer = new RelayLeaseRotationTimer(
    {
      now: () => now,
      setTimer: (_callback, delayMs) => {
        slot.delayMs = delayMs
        return setTimeout(() => {}, 0)
      },
      clearTimer: () => {
        slot.delayMs = null
      }
    },
    () => {}
  )
  const resume = async () => {
    const confirmation = memoryCellConfirm(stored, now, answerNotDue)
    const persisted = await persistResumeConfirmation({
      session: { getResumeConfirmation: () => confirmation, getResumeExpiresAt: () => null },
      bundle,
      usedCredentialVersion: 2,
      writeBundle: async () => {}
    })
    bundle = persisted.bundle
    timer.scheduleFromLease(persisted.leaseExpiry)
  }
  await resume()
  let resumes = 1
  while (slot.delayMs !== null && now < Date.parse('2026-10-19T00:00:00Z') + days * DAY) {
    now += slot.delayMs
    timer.clear()
    await resume()
    resumes += 1
    expect(bundle.current.expiresAt).toBeGreaterThan(now)
    expect(mobileRelayCredentialNeedsRotation(bundle, now)).toBe(false)
  }
  return { now, bundle, stored, resumes, timerArmed: timer.pending }
}

describe('relay renewal under the step-6 memory cell rule', () => {
  it('keeps a relay-only phone valid for 31 days, with its lease timer armed after every confirm', async () => {
    const phone = await relayOnlyPhone(31, 'renewed')
    expect(phone.timerArmed).toBe(true)
    expect(phone.resumes).toBeGreaterThanOrEqual(31 * 4)
    expect(phone.stored.renewals).toBeLessThanOrEqual(32)
    expect(phone.bundle.current.expiresAt).toBe(phone.stored.expiresAt)
    expect(phone.bundle.current.expiresAt - phone.now).toBeGreaterThan(
      RESUME_TTL_MS - 2 * RENEWAL_INTERVAL_MS
    )
  })

  it('would strand that phone if a not-due confirm answered renewed:false', async () => {
    // An unchanged confirmation would stop this shipped phone’s lease timer immediately.
    const phone = await relayOnlyPhone(31, 'unchanged')
    expect(phone.resumes).toBe(1)
    expect(phone.timerArmed).toBe(false)
  })
})
