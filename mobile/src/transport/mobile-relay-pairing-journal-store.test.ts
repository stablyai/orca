import { beforeEach, describe, expect, it, vi } from 'vitest'

const asyncStorage = vi.hoisted(() => ({
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn()
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
vi.mock('expo-crypto', () => ({ getRandomBytes: vi.fn() }))
vi.mock('react-native', () => ({ Platform: platform }))

import { createMobileRelayPairingJournal } from './mobile-relay-pairing-journal'
import {
  clearMobileRelayPairingJournal,
  loadMobileRelayPairingJournal,
  resetMobileRelayPairingJournalStoreForTests,
  saveMobileRelayPairingJournal,
  updateMobileRelayPairingJournal
} from './mobile-relay-pairing-journal-store'
import type { PairingOffer } from './types'

const now = Date.UTC(2026, 6, 13)
const offer = {
  v: 2,
  endpoint: 'ws://192.168.1.10:6768',
  deviceToken: 'device-token-secret',
  publicKeyB64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  relay: {
    v: 1,
    directorUrl: 'https://relay.onorca.dev',
    cellUrl: 'https://relay-c1.onorca.dev',
    assignmentEpoch: 7,
    relayHostId: 'AbCdEf0123_-xyZ9',
    inviteToken: 'abcdefghijklmnopqrstuvwxyzABCDEFGH012345678',
    inviteExpiresAt: now + 300_000,
    e2eeFraming: 2
  }
} satisfies PairingOffer

describe('mobile relay pairing journal store', () => {
  let metadataRaw: string | null
  let secretRaw: string | null

  beforeEach(() => {
    vi.clearAllMocks()
    resetMobileRelayPairingJournalStoreForTests()
    platform.OS = 'ios'
    metadataRaw = null
    secretRaw = null
    asyncStorage.getItem.mockImplementation(async () => metadataRaw)
    asyncStorage.setItem.mockImplementation(async (_key: string, value: string) => {
      metadataRaw = value
    })
    asyncStorage.removeItem.mockImplementation(async () => {
      metadataRaw = null
    })
    secureStore.getItemAsync.mockImplementation(async () => secretRaw)
    secureStore.setItemAsync.mockImplementation(async (_key: string, value: string) => {
      secretRaw = value
    })
    secureStore.deleteItemAsync.mockImplementation(async () => {
      secretRaw = null
    })
  })

  it('persists metadata before secrets and never places bearers in AsyncStorage', async () => {
    const journal = createMobileRelayPairingJournal({
      offer: offer as PairingOffer & { relay: NonNullable<PairingOffer['relay']> },
      hostId: 'host-1',
      hostName: 'Blue Whale',
      now,
      randomBytes: (length) => new Uint8Array(length).fill(length)
    })

    await saveMobileRelayPairingJournal(journal)

    expect(asyncStorage.setItem.mock.invocationCallOrder[0]).toBeLessThan(
      secureStore.setItemAsync.mock.invocationCallOrder[0]!
    )
    expect(metadataRaw).not.toContain(offer.deviceToken)
    expect(metadataRaw).not.toContain(offer.relay.inviteToken)
    expect(metadataRaw).not.toContain(journal.secrets.pendingResumeToken)
    await expect(loadMobileRelayPairingJournal()).resolves.toEqual(journal)
  })

  it('records a provisional winner only for the active journal identity', async () => {
    const journal = createMobileRelayPairingJournal({
      offer: offer as PairingOffer & { relay: NonNullable<PairingOffer['relay']> },
      hostId: 'host-1',
      hostName: 'Blue Whale',
      randomBytes: (length) => new Uint8Array(length).fill(7)
    })
    await saveMobileRelayPairingJournal(journal)

    await updateMobileRelayPairingJournal(journal.metadata.journalId, (metadata) => ({
      ...metadata,
      winner: 'direct',
      authorizationMode: 'authenticated-direct'
    }))
    await expect(
      updateMobileRelayPairingJournal('stale-journal', (metadata) => metadata)
    ).rejects.toThrow(/stale/)
    expect(JSON.parse(metadataRaw!)).toMatchObject({
      winner: 'direct',
      authorizationMode: 'authenticated-direct'
    })
  })

  it('treats metadata without its secret record as an incomplete crash', async () => {
    const journal = createMobileRelayPairingJournal({
      offer: offer as PairingOffer & { relay: NonNullable<PairingOffer['relay']> },
      hostId: 'host-1',
      hostName: 'Blue Whale',
      randomBytes: (length) => new Uint8Array(length).fill(9)
    })
    metadataRaw = JSON.stringify(journal.metadata)

    await expect(loadMobileRelayPairingJournal()).resolves.toBeNull()
    expect(metadataRaw).toBeNull()
  })

  it('cleans mismatched secret records and refuses to replace a recoverable journal', async () => {
    const journal = createMobileRelayPairingJournal({
      offer: offer as PairingOffer & { relay: NonNullable<PairingOffer['relay']> },
      hostId: 'host-1',
      hostName: 'Blue Whale',
      randomBytes: (length) => new Uint8Array(length).fill(10)
    })
    metadataRaw = JSON.stringify(journal.metadata)
    secretRaw = JSON.stringify({ ...journal.secrets, journalId: 'different-journal' })
    await expect(loadMobileRelayPairingJournal()).resolves.toBeNull()
    expect(metadataRaw).toBeNull()
    expect(secretRaw).toBeNull()

    await saveMobileRelayPairingJournal(journal)
    const replacement = createMobileRelayPairingJournal({
      offer: offer as PairingOffer & { relay: NonNullable<PairingOffer['relay']> },
      hostId: 'host-2',
      hostName: 'Red Panda',
      randomBytes: (length) => new Uint8Array(length).fill(12)
    })
    await expect(saveMobileRelayPairingJournal(replacement)).rejects.toThrow(/recovery pending/)
    await expect(loadMobileRelayPairingJournal()).resolves.toEqual(journal)
  })

  it('clears metadata before deleting its secret and keeps relay unavailable on web', async () => {
    const journal = createMobileRelayPairingJournal({
      offer: offer as PairingOffer & { relay: NonNullable<PairingOffer['relay']> },
      hostId: 'host-1',
      hostName: 'Blue Whale',
      randomBytes: (length) => new Uint8Array(length).fill(11)
    })
    await saveMobileRelayPairingJournal(journal)
    await clearMobileRelayPairingJournal(journal.metadata.journalId)
    expect(asyncStorage.removeItem.mock.invocationCallOrder[0]).toBeLessThan(
      secureStore.deleteItemAsync.mock.invocationCallOrder[0]!
    )

    platform.OS = 'web'
    await expect(saveMobileRelayPairingJournal(journal)).rejects.toThrow(/native secret store/)
  })
})
