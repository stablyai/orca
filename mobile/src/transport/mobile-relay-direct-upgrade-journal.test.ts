import { beforeEach, describe, expect, it, vi } from 'vitest'

const keychain = vi.hoisted(() => ({
  deletePairingKeychainItemIfMatches: vi.fn(),
  readPairingKeychainItem: vi.fn()
}))

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))
vi.mock('./pairing-keychain', () => ({
  deletePairingKeychainItem: vi.fn(),
  deletePairingKeychainItemIfMatches: keychain.deletePairingKeychainItemIfMatches,
  readPairingKeychainItem: keychain.readPairingKeychainItem,
  writePairingKeychainItem: vi.fn()
}))

import {
  createMobileRelayDirectUpgradeJournal,
  retireMobileRelayDirectUpgradeJournalForRelayHost
} from './mobile-relay-direct-upgrade-journal'

describe('mobile relay direct upgrade journal retirement', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    keychain.deletePairingKeychainItemIfMatches.mockResolvedValue(true)
  })

  it('conditionally clears the retained journal when a relay profile takes ownership', async () => {
    const journal = createMobileRelayDirectUpgradeJournal('host-1', (length) =>
      new Uint8Array(length).fill(7)
    )
    keychain.readPairingKeychainItem.mockResolvedValue(JSON.stringify(journal))

    await retireMobileRelayDirectUpgradeJournalForRelayHost(journal.hostId)

    expect(keychain.deletePairingKeychainItemIfMatches).toHaveBeenCalledWith(
      `orca.mobile-relay.direct-upgrade.${journal.hostId}`,
      JSON.stringify(journal)
    )
  })

  it('does not clear a replacement journal after the owning lifecycle stops', async () => {
    const journal = createMobileRelayDirectUpgradeJournal('host-1', (length) =>
      new Uint8Array(length).fill(8)
    )
    let resolveRead: ((raw: string) => void) | null = null
    keychain.readPairingKeychainItem.mockReturnValueOnce(
      new Promise<string>((resolve) => {
        resolveRead = resolve
      })
    )
    let active = true
    const retirement = retireMobileRelayDirectUpgradeJournalForRelayHost(
      journal.hostId,
      () => active
    )

    active = false
    resolveRead?.(JSON.stringify(journal))
    await retirement

    expect(keychain.deletePairingKeychainItemIfMatches).not.toHaveBeenCalled()
  })
})
