import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { InstalledBrowserExtension } from '../../../../shared/browser/extensions/browser-extension-types'

const mocks = vi.hoisted(() => ({
  loaded: new Set<string>(),
  load: vi.fn(),
  prepare: vi.fn(async () => {})
}))

vi.mock('../../sessions/profiles/browser-session-registry', () => ({
  browserSessionRegistry: {
    listProfiles: () => ['a', 'b', 'c'].map((id) => ({ id })),
    getEnabledExtensionIds: () => ['ext']
  }
}))
vi.mock('../installation/browser-extension-load-directory', () => ({
  prepareBrowserExtensionDirectory: mocks.prepare
}))
vi.mock('../installation/browser-extension-list-changes', () => ({
  notifyBrowserExtensionListChanged: vi.fn()
}))
vi.mock('./browser-extension-idle-kept-state', () => ({
  noteBrowserExtensionReloadedWhileIdle: vi.fn(),
  noteBrowserExtensionReloadPendingInIdleProfile: vi.fn()
}))
vi.mock('../declarative-net-request/session/browser-extension-dnr-store', () => ({
  getBrowserExtensionDnrStore: () => ({ forgetSessionRulesOfOtherVersions: vi.fn() })
}))
vi.mock('./browser-extension-session-loader', () => ({
  getBrowserExtensionSessionForProfile: () => ({}),
  loadBrowserExtensionIntoProfile: mocks.load,
  unloadBrowserExtensionFromProfile: (profileId: string) => mocks.loaded.delete(profileId)
}))

const { reloadBrowserExtensionWhereEnabled } = await import('./browser-extension-profile-reload')
const { forgetBrowserExtensionLoadFailures, getBrowserExtensionLoadFailure } =
  await import('./browser-extension-load-errors')

const extension: InstalledBrowserExtension = {
  id: 'ext',
  name: 'Ext',
  version: '2.0.0',
  path: '/ext',
  source: 'unpacked',
  iconPath: null,
  permissions: [],
  hostPermissions: [],
  optionsPage: null
}

describe('reloading an extension in several profiles', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    forgetBrowserExtensionLoadFailures({})
    mocks.loaded = new Set(['a', 'b', 'c'])
    mocks.load.mockImplementation(async (profileId: string) => {
      if (profileId === 'a') {
        throw new Error('load failed in a')
      }
      mocks.loaded.add(profileId)
    })
  })

  it('still loads later profiles when an earlier one fails, then reports that failure', async () => {
    await expect(reloadBrowserExtensionWhereEnabled(extension, { refresh: true })).rejects.toThrow(
      'load failed in a'
    )
    expect([...mocks.loaded].sort()).toEqual(['b', 'c'])
    expect(getBrowserExtensionLoadFailure('a', 'ext')).toBe('load failed in a')
    expect(getBrowserExtensionLoadFailure('b', 'ext')).toBeNull()
  })

  it('stops at the first failure of a Web Store replace, whose caller rolls every profile back', async () => {
    await expect(reloadBrowserExtensionWhereEnabled(extension)).rejects.toThrow('load failed in a')
    expect(mocks.load).toHaveBeenCalledTimes(1)
    expect(mocks.loaded.size).toBe(0)
  })

  it('shows a failed folder refresh as the load error of every profile it unloaded', async () => {
    mocks.prepare.mockRejectedValueOnce(new Error('copy failed'))
    await expect(reloadBrowserExtensionWhereEnabled(extension, { refresh: true })).rejects.toThrow(
      'copy failed'
    )
    expect(mocks.load).not.toHaveBeenCalled()
    for (const profileId of ['a', 'b', 'c']) {
      expect(getBrowserExtensionLoadFailure(profileId, 'ext')).toBe('copy failed')
    }
  })
})
