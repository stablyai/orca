import { describe, expect, it, vi } from 'vitest'
import { MobileRelayUpgradeHostRemovedError } from './host-store'
import { MobileRelayHostPersistence } from './mobile-relay-host-persistence'
import type { HostProfile } from './types'

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))
vi.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'when-unlocked' }))
vi.mock('expo-crypto', () => ({ getRandomBytes: (length: number) => new Uint8Array(length) }))

const host = {
  id: 'host-1',
  name: 'Blue Whale',
  endpoint: 'ws://192.168.1.10:6768',
  deviceToken: 'device-token',
  publicKeyB64: 'A'.repeat(44),
  lastConnected: 1
} satisfies HostProfile

const relay = {
  v: 1 as const,
  directorUrl: 'https://relay.onorca.dev',
  cellUrl: 'https://relay-c1.onorca.dev',
  assignmentEpoch: 7,
  relayHostId: 'AbCdEf0123_-xyZ9',
  e2eeFraming: 2 as const
}

describe('mobile relay host persistence', () => {
  it('restores the credential tombstone when publication finds a removed host', async () => {
    const deleteBundle = vi.fn(async () => {})
    const persistence = new MobileRelayHostPersistence(
      vi.fn(async () => {}),
      deleteBundle,
      vi.fn(async () => {
        throw new MobileRelayUpgradeHostRemovedError('removed')
      }),
      (length) => new Uint8Array(length),
      setTimeout,
      clearTimeout
    )

    await expect(persistence.persist(host, relay, 1_000)).rejects.toBeInstanceOf(
      MobileRelayUpgradeHostRemovedError
    )
    expect(deleteBundle).toHaveBeenCalledWith(host.id)
  })
})
