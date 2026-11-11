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
  claimMobileRelayPairingJournalPublication,
  loadMobileRelayPairingJournal,
  releaseMobileRelayPairingJournal,
  resetMobileRelayPairingJournalStoreForTests,
  saveMobileRelayPairingJournal,
  updateMobileRelayPairingJournal
} from './mobile-relay-pairing-journal-store'
import type { PairingOffer } from '../../../src/shared/remote-runtime/pairing/mobile-relay-pairing-offer'

const now = Date.UTC(2026, 6, 13)
const GENERATION_KEY = 'orca:pairing-keychain-generation'
const JOURNAL_PRESENCE_KEY = 'orca:pairing-keychain-presence:orca.mobile-relay.pairing-journal.v1'
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
  let generationRaw: string | null
  let presenceRaw: string | null

  beforeEach(() => {
    vi.clearAllMocks()
    resetMobileRelayPairingJournalStoreForTests()
    platform.OS = 'ios'
    metadataRaw = null
    secretRaw = null
    generationRaw = null
    presenceRaw = null
    asyncStorage.getItem.mockImplementation(async (key: string) => {
      if (key === GENERATION_KEY) {
        return generationRaw
      }
      if (key === JOURNAL_PRESENCE_KEY) {
        return presenceRaw
      }
      return metadataRaw
    })
    asyncStorage.setItem.mockImplementation(async (key: string, value: string) => {
      if (key === GENERATION_KEY) {
        generationRaw = value
      } else if (key === JOURNAL_PRESENCE_KEY) {
        presenceRaw = value
      } else {
        metadataRaw = value
      }
    })
    asyncStorage.removeItem.mockImplementation(async (key: string) => {
      if (key === JOURNAL_PRESENCE_KEY) {
        presenceRaw = null
      } else {
        metadataRaw = null
      }
    })
    secureStore.getItemAsync.mockImplementation(async () => secretRaw)
    secureStore.setItemAsync.mockImplementation(async (_key: string, value: string) => {
      secretRaw = value
    })
    secureStore.deleteItemAsync.mockImplementation(async () => {
      secretRaw = null
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

  it('cleans mismatched secret records', async () => {
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
  })

  it('serializes a replacement behind an in-flight journal snapshot', async () => {
    const journal = createMobileRelayPairingJournal({
      offer: offer as PairingOffer & { relay: NonNullable<PairingOffer['relay']> },
      hostId: 'host-1',
      hostName: 'Blue Whale',
      randomBytes: (length) => new Uint8Array(length).fill(10)
    })
    await saveMobileRelayPairingJournal(journal)
    let releaseSecretRead!: () => void
    const secretReadGate = new Promise<void>((resolve) => {
      releaseSecretRead = resolve
    })
    let enteredSecretRead = () => {}
    const secretReadStarted = new Promise<void>((resolve) => {
      enteredSecretRead = resolve
    })
    secureStore.getItemAsync.mockImplementationOnce(async () => {
      enteredSecretRead()
      await secretReadGate
      return secretRaw
    })
    const loading = loadMobileRelayPairingJournal()
    await secretReadStarted

    const replacement = createMobileRelayPairingJournal({
      offer: offer as PairingOffer & { relay: NonNullable<PairingOffer['relay']> },
      hostId: 'host-2',
      hostName: 'Red Panda',
      randomBytes: (length) => new Uint8Array(length).fill(12)
    })
    let replacementSaved = false
    const saving = saveMobileRelayPairingJournal(replacement).then(() => {
      replacementSaved = true
    })
    await Promise.resolve()
    expect(replacementSaved).toBe(false)

    releaseSecretRead()
    await expect(loading).resolves.toEqual(journal)
    await expect(saving).resolves.toBeUndefined()
    await expect(loadMobileRelayPairingJournal()).resolves.toEqual(replacement)
    expect(asyncStorage.removeItem).not.toHaveBeenCalled()
  })

  it('cleans a replacement whose secret write fails', async () => {
    const journal = createMobileRelayPairingJournal({
      offer: offer as PairingOffer & { relay: NonNullable<PairingOffer['relay']> },
      hostId: 'host-1',
      hostName: 'Blue Whale',
      randomBytes: (length) => new Uint8Array(length).fill(10)
    })
    await saveMobileRelayPairingJournal(journal)
    const replacement = createMobileRelayPairingJournal({
      offer: offer as PairingOffer & { relay: NonNullable<PairingOffer['relay']> },
      hostId: 'host-2',
      hostName: 'Red Panda',
      randomBytes: (length) => new Uint8Array(length).fill(12)
    })
    secureStore.setItemAsync.mockRejectedValue(new Error('keychain unavailable'))

    await expect(saveMobileRelayPairingJournal(replacement)).rejects.toThrow(/keychain/)
    await expect(loadMobileRelayPairingJournal()).resolves.toBeNull()
    expect(metadataRaw).toBeNull()
    expect(secretRaw).toBeNull()
  })

  it('blocks replacement when the old authorization update wins the mutation race', async () => {
    const journal = createMobileRelayPairingJournal({
      offer: offer as PairingOffer & { relay: NonNullable<PairingOffer['relay']> },
      hostId: 'host-1',
      hostName: 'Blue Whale',
      randomBytes: (length) => new Uint8Array(length).fill(10)
    })
    await saveMobileRelayPairingJournal(journal)
    const replacement = createMobileRelayPairingJournal({
      offer: offer as PairingOffer & { relay: NonNullable<PairingOffer['relay']> },
      hostId: 'host-2',
      hostName: 'Red Panda',
      randomBytes: (length) => new Uint8Array(length).fill(12)
    })
    const authorizationUpdate = updateMobileRelayPairingJournal(
      journal.metadata.journalId,
      (metadata) => ({
        ...metadata,
        winner: 'direct',
        authorizationMode: 'authenticated-direct'
      })
    )
    const replacementSave = saveMobileRelayPairingJournal(replacement)

    await expect(authorizationUpdate).resolves.toBeUndefined()
    await expect(replacementSave).rejects.toThrow(/pairing in progress/)
  })

  // New scans must supersede stranded authorized journals instead of blocking until expiry (#12518).

  it('makes a superseding scan wait for a publication in progress, and refuses a stale claim', async () => {
    vi.useFakeTimers()
    try {
      const created = createMobileRelayPairingJournal({
        offer: offer as PairingOffer & { relay: NonNullable<PairingOffer['relay']> },
        hostId: 'host-1',
        hostName: 'Blue Whale',
        randomBytes: (length) => new Uint8Array(length).fill(10)
      })
      await saveMobileRelayPairingJournal(created)
      releaseMobileRelayPairingJournal(created.metadata.journalId)
      const release = await claimMobileRelayPairingJournalPublication(created.metadata.journalId)
      const replacement = createMobileRelayPairingJournal({
        offer: offer as PairingOffer & { relay: NonNullable<PairingOffer['relay']> },
        hostId: 'host-2',
        hostName: 'Red Panda',
        randomBytes: (length) => new Uint8Array(length).fill(12)
      })
      let saved = false
      const save = saveMobileRelayPairingJournal(replacement).then(() => (saved = true))
      await vi.advanceTimersByTimeAsync(0)
      expect(saved).toBe(false)

      await clearMobileRelayPairingJournal(created.metadata.journalId)
      release()
      await save
      await expect(loadMobileRelayPairingJournal()).resolves.toEqual(replacement)
      await expect(
        claimMobileRelayPairingJournalPublication(created.metadata.journalId)
      ).rejects.toThrow(/stale/)
    } finally {
      vi.useRealTimers()
    }
  })
})
