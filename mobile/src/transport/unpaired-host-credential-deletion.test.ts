import { beforeEach, describe, expect, it, vi } from 'vitest'

const asyncStorage = vi.hoisted(() => ({
  getItem: vi.fn(async () => null),
  setItem: vi.fn(async () => undefined),
  removeItem: vi.fn(async () => undefined)
}))
const deletions = vi.hoisted(() => ({
  deviceToken: vi.fn(async () => undefined),
  credentialBundle: vi.fn(async () => undefined),
  directUpgradeJournal: vi.fn(async () => undefined),
  clearWriteRevision: vi.fn()
}))

vi.mock('@react-native-async-storage/async-storage', () => ({ default: asyncStorage }))
vi.mock('./host-device-token-store', () => ({ deleteHostDeviceToken: deletions.deviceToken }))
vi.mock('./mobile-relay-credential-bundle', () => ({
  deleteMobileRelayCredentialBundle: deletions.credentialBundle
}))
vi.mock('./mobile-relay-direct-upgrade-journal', () => ({
  deleteMobileRelayDirectUpgradeJournal: deletions.directUpgradeJournal
}))
vi.mock('./host-credential-write-revision', () => ({
  clearHostCredentialWriteRevision: deletions.clearWriteRevision,
  getHostCredentialWriteRevision: () => 0
}))

import { createUnpairedHostCredentialDeletion } from './unpaired-host-credential-deletion'
import {
  getSessionTabStripCacheKey,
  readCachedSessionTabStrip,
  resetSessionTabStripCacheForTests,
  saveCachedSessionTabStrip
} from '../cache/session-tab-strip-cache'

const strip = {
  tabs: [{ id: 'tab-1', type: 'terminal' as const, title: 'Terminal', agentId: null }],
  activeTabId: 'tab-1'
}

function createDeletion(storedHostIds: string[] = []) {
  return createUnpairedHostCredentialDeletion({
    waitForHostMutations: async () => undefined,
    hasStoredHost: async (hostId) => storedHostIds.includes(hostId),
    onDeleted: vi.fn()
  })
}

beforeEach(() => {
  asyncStorage.getItem.mockClear()
  asyncStorage.setItem.mockClear()
  for (const mock of Object.values(deletions)) {
    mock.mockClear()
  }
  resetSessionTabStripCacheForTests()
})

describe('unpaired host credential deletion', () => {
  it('takes the cached tab strip with the credentials, leaving other hosts alone', async () => {
    // Why: the strip is not a credential, but it is host-scoped plaintext written from the
    // session screen. Without this sweep it outlives the pairing that produced it.
    const unpaired = getSessionTabStripCacheKey('host-1', 'wt-1')
    const other = getSessionTabStripCacheKey('host-2', 'wt-1')
    saveCachedSessionTabStrip(unpaired, strip)
    saveCachedSessionTabStrip(other, strip)

    await createDeletion()('host-1', 0)

    expect(readCachedSessionTabStrip(unpaired)).toBeNull()
    expect(readCachedSessionTabStrip(other)?.tabs).toHaveLength(1)
  })

  it('leaves the strip alone when the host turned out to still be paired', async () => {
    const stillPaired = getSessionTabStripCacheKey('host-1', 'wt-1')
    saveCachedSessionTabStrip(stillPaired, strip)

    await createDeletion(['host-1'])('host-1', 0)

    expect(readCachedSessionTabStrip(stillPaired)?.tabs).toHaveLength(1)
    expect(deletions.deviceToken).not.toHaveBeenCalled()
  })
})
