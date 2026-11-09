import { beforeEach, describe, expect, it, vi } from 'vitest'

const asyncStorage = vi.hoisted(() => ({
  getItem: vi.fn(),
  setItem: vi.fn()
}))
const secureStore = vi.hoisted(() => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn()
}))
const platform = vi.hoisted(() => ({ OS: 'ios' }))

vi.mock('@react-native-async-storage/async-storage', () => ({ default: asyncStorage }))
vi.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY',
  ...secureStore
}))
vi.mock('react-native', () => ({ Platform: platform }))

import { promotePairingJournalCredential } from './mobile-relay-credential-bundle'
import type { MobileRelayPairingJournal } from '../../pairing/mobile-relay-pairing-journal'
import { resetPairingKeychainForTests } from './pairing-keychain'

const journal = {
  metadata: {
    v: 1,
    journalId: 'pair-1',
    offerFingerprint: 'A'.repeat(43),
    host: {
      id: 'host-1',
      name: 'Blue Whale',
      endpoint: 'ws://192.168.1.10:6768',
      publicKeyB64: 'A'.repeat(44),
      lastConnected: 1
    },
    relay: {
      v: 1,
      directorUrl: 'https://relay.onorca.dev',
      cellUrl: 'https://relay-c1.onorca.dev',
      assignmentEpoch: 7,
      relayHostId: 'AbCdEf0123_-xyZ9',
      inviteExpiresAt: 10_000,
      e2eeFraming: 2
    },
    installReqId: 'install-1',
    resumeConfirmReqId: 'confirm-1',
    pendingResumeTokenHash: 'B'.repeat(43),
    winner: 'direct',
    authorizationMode: 'authenticated-direct'
  },
  secrets: {
    v: 1,
    journalId: 'pair-1',
    deviceToken: 'device-token',
    inviteToken: 'C'.repeat(43),
    pendingResumeToken: 'D'.repeat(43)
  }
} satisfies MobileRelayPairingJournal

describe('mobile relay credential bundle', () => {
  const stored = new Map<string, string>()

  beforeEach(() => {
    vi.clearAllMocks()
    resetPairingKeychainForTests()
    platform.OS = 'ios'
    stored.clear()
    asyncStorage.getItem.mockResolvedValue(null)
    asyncStorage.setItem.mockResolvedValue(undefined)
    secureStore.getItemAsync.mockImplementation(async (key: string) => stored.get(key) ?? null)
    secureStore.setItemAsync.mockImplementation(async (key: string, value: string) => {
      stored.set(key, value)
    })
    secureStore.deleteItemAsync.mockImplementation(async (key: string) => {
      stored.delete(key)
    })
  })

  it('rejects a result from another request or authorization mode', () => {
    const installed = {
      v: 1 as const,
      reqId: 'install-1',
      authorizationMode: 'authenticated-direct' as const,
      currentVersion: 1,
      resumeExpiresAt: 50_000
    }
    expect(() =>
      promotePairingJournalCredential({
        journal,
        installed: { ...installed, reqId: 'other-request' }
      })
    ).toThrow(/does not match/)
    expect(() =>
      promotePairingJournalCredential({
        journal,
        installed: { ...installed, authorizationMode: 'relay-basis' }
      })
    ).toThrow(/does not match/)
  })
})
