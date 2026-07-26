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
  MOBILE_RELAY_DIRECT_UPGRADE_MAX_STORAGE_CHARACTERS,
  createMobileRelayDirectUpgradeJournal,
  readMobileRelayDirectUpgradeJournal,
  writeMobileRelayDirectUpgradeJournal
} from './mobile-relay-direct-upgrade-journal'
import { MOBILE_HOST_ID_MAX_CHARACTERS } from './types'

describe('mobile relay direct-upgrade journal storage', () => {
  let stored: string | null

  beforeEach(() => {
    vi.clearAllMocks()
    platform.OS = 'ios'
    stored = null
    secureStore.getItemAsync.mockImplementation(async () => stored)
    secureStore.setItemAsync.mockImplementation(async (_key: string, value: string) => {
      stored = value
    })
  })

  it('round-trips the exact host-id and raw limits', async () => {
    const hostId = 'h'.repeat(MOBILE_HOST_ID_MAX_CHARACTERS)
    const journal = createMobileRelayDirectUpgradeJournal(hostId, (length) =>
      new Uint8Array(length).fill(7)
    )

    await writeMobileRelayDirectUpgradeJournal(journal)
    const serialized = stored!
    stored =
      serialized +
      ' '.repeat(MOBILE_RELAY_DIRECT_UPGRADE_MAX_STORAGE_CHARACTERS - serialized.length)

    await expect(readMobileRelayDirectUpgradeJournal(hostId)).resolves.toEqual(journal)
  })

  it('rejects a host id one character beyond the limit', () => {
    expect(() =>
      createMobileRelayDirectUpgradeJournal(
        'h'.repeat(MOBILE_HOST_ID_MAX_CHARACTERS + 1),
        (length) => new Uint8Array(length)
      )
    ).toThrow()
  })

  it('does not parse an oversized secure-store record', async () => {
    stored = {
      length: MOBILE_RELAY_DIRECT_UPGRADE_MAX_STORAGE_CHARACTERS + 1
    } as unknown as string
    const parse = vi.spyOn(JSON, 'parse')

    await expect(readMobileRelayDirectUpgradeJournal('host-1')).resolves.toBeNull()
    expect(parse).not.toHaveBeenCalled()
    parse.mockRestore()
  })

  it('does not construct a secure-store key for an oversized host id', async () => {
    await expect(
      readMobileRelayDirectUpgradeJournal('h'.repeat(MOBILE_HOST_ID_MAX_CHARACTERS + 1))
    ).resolves.toBeNull()
    expect(secureStore.getItemAsync).not.toHaveBeenCalled()
  })
})
