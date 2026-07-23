import { beforeEach, describe, expect, it, vi } from 'vitest'

const secureStore = vi.hoisted(() => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn()
}))
const platform = vi.hoisted(() => ({ OS: 'ios' }))

vi.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY',
  ...secureStore
}))
vi.mock('react-native', () => ({ Platform: platform }))

import {
  MOBILE_RELAY_CREDENTIAL_BUNDLE_MAX_STORAGE_CHARACTERS,
  deleteMobileRelayCredentialBundle,
  promotePairingJournalCredential,
  readMobileRelayCredentialBundle,
  writeMobileRelayCredentialBundle
} from './mobile-relay-credential-bundle'
import type { MobileRelayPairingJournal } from './mobile-relay-pairing-journal'
import { MOBILE_HOST_ID_MAX_CHARACTERS, PAIRING_DEVICE_TOKEN_MAX_CHARACTERS } from './types'

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
  let stored: string | null

  beforeEach(() => {
    vi.clearAllMocks()
    platform.OS = 'ios'
    stored = null
    secureStore.getItemAsync.mockImplementation(async () => stored)
    secureStore.setItemAsync.mockImplementation(async (_key: string, value: string) => {
      stored = value
    })
    secureStore.deleteItemAsync.mockImplementation(async () => {
      stored = null
    })
  })

  it('promotes only a matching committed install result to current', async () => {
    const bundle = promotePairingJournalCredential({
      journal,
      installed: {
        v: 1,
        reqId: 'install-1',
        authorizationMode: 'authenticated-direct',
        currentVersion: 3,
        resumeExpiresAt: 50_000
      }
    })
    await writeMobileRelayCredentialBundle(bundle)

    await expect(readMobileRelayCredentialBundle('host-1')).resolves.toEqual(bundle)
    expect(stored).toContain(journal.secrets.pendingResumeToken)
    expect(stored).not.toContain(journal.secrets.inviteToken)
  })

  it('rejects a result from another request or authorization mode', () => {
    expect(() =>
      promotePairingJournalCredential({
        journal,
        installed: {
          v: 1,
          reqId: 'other-request',
          authorizationMode: 'relay-basis',
          currentVersion: 1,
          resumeExpiresAt: 50_000
        }
      })
    ).toThrow(/does not match/)
  })

  it('round-trips exact field and raw limits and rejects one character more', async () => {
    const exact = {
      v: 1 as const,
      hostId: 'h'.repeat(MOBILE_HOST_ID_MAX_CHARACTERS),
      deviceToken: 't'.repeat(PAIRING_DEVICE_TOKEN_MAX_CHARACTERS),
      current: {
        token: 'A'.repeat(43),
        hash: 'B'.repeat(43),
        version: 1,
        expiresAt: 10_000
      }
    }

    await expect(writeMobileRelayCredentialBundle(exact)).resolves.toBeUndefined()
    const serialized = stored!
    stored =
      serialized +
      ' '.repeat(MOBILE_RELAY_CREDENTIAL_BUNDLE_MAX_STORAGE_CHARACTERS - serialized.length)
    await expect(readMobileRelayCredentialBundle(exact.hostId)).resolves.toEqual(exact)
    await expect(
      writeMobileRelayCredentialBundle({
        ...exact,
        deviceToken: `${exact.deviceToken}t`
      })
    ).rejects.toThrow()
  })

  it('does not parse an oversized secure-store record', async () => {
    stored = {
      length: MOBILE_RELAY_CREDENTIAL_BUNDLE_MAX_STORAGE_CHARACTERS + 1
    } as unknown as string
    const parse = vi.spyOn(JSON, 'parse')

    await expect(readMobileRelayCredentialBundle('host-1')).resolves.toBeNull()
    expect(parse).not.toHaveBeenCalled()
    parse.mockRestore()
  })

  it('does not construct a secure-store key for an oversized host id', async () => {
    await expect(
      readMobileRelayCredentialBundle('h'.repeat(MOBILE_HOST_ID_MAX_CHARACTERS + 1))
    ).resolves.toBeNull()
    expect(secureStore.getItemAsync).not.toHaveBeenCalled()
  })

  it('deletes the namespaced bundle and never enables it on web', async () => {
    await deleteMobileRelayCredentialBundle('host-1')
    expect(secureStore.deleteItemAsync).toHaveBeenCalledWith(
      'orca.mobile-relay.credentials.host-1',
      expect.any(Object)
    )
    platform.OS = 'web'
    await expect(readMobileRelayCredentialBundle('host-1')).rejects.toThrow(/native secret store/)
  })
})
