import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DeviceResumeConfirmed } from '../../../src/shared/mobile-relay-credential-contract'
import type { MobileRelayCredentialBundle } from './mobile-relay-credential-bundle'
import { hashMobileRelayCredential } from './mobile-relay-credential-hash'
import { persistResumeConfirmation } from './mobile-relay-credential-rotation'
import { RelayLeaseRotationTimer } from './mobile-relay-lease-rotation-timer'

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))
vi.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'when-unlocked' }))
vi.mock('expo-crypto', () => ({ getRandomBytes: (length: number) => new Uint8Array(length) }))

const TOKEN = 'A'.repeat(43)
const INITIAL_EXPIRY = 2_592_001_000

function credentialBundle(): MobileRelayCredentialBundle {
  return {
    v: 1,
    hostId: 'host-1',
    deviceToken: 'device-token',
    current: {
      token: TOKEN,
      hash: hashMobileRelayCredential(TOKEN),
      version: 2,
      expiresAt: INITIAL_EXPIRY
    }
  }
}

async function confirm(confirmation: DeviceResumeConfirmed) {
  const writeBundle = vi.fn(async (_bundle: MobileRelayCredentialBundle) => {})
  const persisted = await persistResumeConfirmation({
    session: { getResumeConfirmation: () => confirmation, getResumeExpiresAt: () => 9_999 },
    bundle: credentialBundle(),
    usedCredentialVersion: 2,
    writeBundle
  })
  const onRotate = vi.fn()
  const timer = new RelayLeaseRotationTimer(
    { now: Date.now, setTimer: setTimeout, clearTimer: clearTimeout },
    onRotate
  )
  timer.scheduleFromLease(persisted.leaseExpiry)
  return { ...persisted, writeBundle, timer, onRotate }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('mobile relay resume confirmation scheduling', () => {
  it('persists a current confirmation and fires its six-hour re-resume timer', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const phone = await confirm({
      v: 1,
      reqId: 'confirm-current',
      currentVersion: 2,
      acceptedAs: 'current',
      renewed: true,
      resumeExpiresAt: 2_678_401_000
    })

    expect(phone.bundle.current.expiresAt).toBe(2_678_401_000)
    expect(phone.writeBundle).toHaveBeenCalledExactlyOnceWith({
      ...credentialBundle(),
      current: { ...credentialBundle().current, expiresAt: 2_678_401_000 }
    })
    expect(phone.leaseExpiry).toBe(2_678_401_000)
    expect(phone.timer.pending).toBe(true)
    await vi.advanceTimersByTimeAsync(21_599_999)
    expect(phone.onRotate).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(phone.onRotate).toHaveBeenCalledOnce()
    expect(phone.timer.pending).toBe(false)
  })

  it('keeps an unchanged confirmation durable without arming a re-resume timer', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const phone = await confirm({
      v: 1,
      reqId: 'confirm-unchanged',
      currentVersion: 2,
      acceptedAs: 'current',
      renewed: false,
      resumeExpiresAt: INITIAL_EXPIRY
    })

    expect(phone.bundle).toEqual(credentialBundle())
    expect(phone.writeBundle).toHaveBeenCalledExactlyOnceWith(credentialBundle())
    expect(phone.leaseExpiry).toBeNull()
    expect(phone.timer.pending).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(2_678_400_000)
    expect(phone.onRotate).not.toHaveBeenCalled()
  })
})
