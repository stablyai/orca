import { BrowserHostLeaseRegistry } from '../browser-host/browser-host-lease-registry'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RuntimeBrowserPageRegistry } from '../runtime-browser-page-registry'

const mocks = vi.hoisted(() => ({
  getProfile: vi.fn(),
  getDefaultProfile: vi.fn(),
  getLocalProfile: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
  wait: vi.fn()
}))
vi.mock('electron', () => ({
  ipcMain: { on: mocks.on, removeListener: mocks.removeListener }
}))
vi.mock('../../browser/browser-session-registry', () => ({
  browserSessionRegistry: {
    getProfile: mocks.getProfile,
    getDefaultProfile: mocks.getDefaultProfile
  }
}))
vi.mock('../../browser/browser-manager', () => ({
  browserManager: { getSessionProfileIdForTab: mocks.getLocalProfile }
}))
vi.mock('../../ipc/browser-tab-registration-wait', () => ({
  waitForTabRegistration: mocks.wait
}))
import { RuntimeBrowserProfiles } from './browser-profiles'
import { RuntimeBrowserTabCatalog } from './browser-tab-catalog'

const profiles = [
  { scope: 'default', id: 'default', label: 'Default', partition: 'persist:local-default' },
  { scope: 'isolated', id: 'isolated', label: 'Isolated', partition: 'persist:local-isolated' }
]

function fixture(currentProfile = 'isolated') {
  const pages = new RuntimeBrowserPageRegistry()
  pages.publishClientPage({
    browserPageId: 'remote-page',
    workspaceId: 'workspace',
    browserProfileId: currentProfile,
    executionHostKey: 'remote-host',
    placement: {
      kind: 'client',
      browserHostClientId: 'desktop',
      browserHostGeneration: 1,
      pageHostGeneration: 1
    },
    url: 'https://example.com/authenticated',
    loading: false,
    active: true
  })
  const window = vi.fn(() => {
    throw new Error('must not access renderer')
  })
  const bridge = vi.fn(() => {
    throw new Error('must not require local bridge')
  })
  const leases = new BrowserHostLeaseRegistry({ authorityRuntimeId: 'runtime' })
  const switchProfile = vi
    .spyOn(leases, 'switchClientPageProfile')
    .mockRejectedValue(new Error('requires staged replacement support on both peers'))
  const notify = vi.fn()
  const localTarget = vi.fn(async () => {
    throw new Error('must not resolve a server-local target')
  })
  const runtime = new RuntimeBrowserProfiles(
    {
      getRuntimeBrowserPageRegistry: () => pages,
      getAuthoritativeWindow: window,
      getBrowserHostLeaseRegistry: () => leases,
      notifyHeadlessBrowserSessionTabsChanged: notify
    },
    { resolveBrowserCommandTarget: localTarget, requireAgentBrowserBridge: bridge },
    new RuntimeBrowserTabCatalog(
      {
        getAgentBrowserBridge: () => null,
        // Folder selectors resolve here, never through the server-local worktree resolver.
        resolveBrowserWorkspace: async (selector) => ({
          id: selector === 'id:folder:workspace' ? 'workspace' : selector
        }),
        getRuntimeBrowserPageRegistry: () => pages
      },
      { requireAgentBrowserBridge: bridge }
    )
  )
  return { pages, runtime, window, bridge, switchProfile, notify, localTarget }
}

describe('client placement profile switch safety', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getProfile.mockImplementation((id) => profiles.find((profile) => profile.id === id))
    mocks.getDefaultProfile.mockReturnValue(profiles[0])
    mocks.getLocalProfile.mockReturnValue('default')
  })

  it.each([
    ['isolated', 'default'],
    ['default', 'isolated']
  ])('rejects %s to %s without mutating the old guest or metadata', async (current, next) => {
    const { pages, runtime, window, bridge } = fixture(current)
    const before = pages.getPage('remote-page')
    await expect(
      runtime.browserTabSetProfile({ page: 'remote-page', profileId: next })
    ).rejects.toThrow('requires staged replacement support on both peers')
    expect(pages.getPage('remote-page')).toBe(before)
    expect(window).not.toHaveBeenCalled()
    expect(bridge).not.toHaveBeenCalled()
    expect(mocks.getLocalProfile).not.toHaveBeenCalled()
    expect(mocks.on).not.toHaveBeenCalled()
    expect(mocks.wait).not.toHaveBeenCalled()
  })

  it('commits a proven replacement profile and generation before notifying session readers', async () => {
    const { pages, runtime, switchProfile, notify } = fixture()
    const previous = pages.getPage('remote-page')!
    const replacement = { ...previous.placement, pageHostGeneration: 2 }
    switchProfile.mockResolvedValue(replacement)
    await expect(
      runtime.browserTabSetProfile({ page: 'remote-page', profileId: 'default' })
    ).resolves.toMatchObject({ profileId: 'default' })
    expect(switchProfile).toHaveBeenCalledWith(
      expect.objectContaining({ browserPageId: 'remote-page', pageHostGeneration: 1 }),
      { id: 'default', label: 'Default', scope: 'default' },
      expect.any(Function)
    )
    expect(pages.getPage('remote-page')).toMatchObject({
      browserProfileId: 'default',
      placement: replacement,
      metadataRevision: 0
    })
    expect(notify).toHaveBeenCalledWith('workspace')
  })

  it('uses authoritative profile identity for an actual no-op', async () => {
    const { runtime, window } = fixture()
    await expect(
      runtime.browserTabSetProfile({ page: 'remote-page', profileId: 'isolated' })
    ).resolves.toEqual({
      browserPageId: 'remote-page',
      profileId: 'isolated',
      profileLabel: 'Isolated'
    })
    expect(mocks.getLocalProfile).not.toHaveBeenCalled()
    expect(window).not.toHaveBeenCalled()
  })

  it('resolves the active client page without a server-local bridge', async () => {
    const { runtime, bridge } = fixture()
    await expect(
      runtime.browserTabSetProfile({ worktree: 'workspace', profileId: 'isolated' })
    ).resolves.toMatchObject({ browserPageId: 'remote-page', profileId: 'isolated' })
    expect(bridge).not.toHaveBeenCalled()
  })

  it('rejects an invalid profile without changing authoritative state', async () => {
    const { pages, runtime, window } = fixture()
    const before = pages.getPage('remote-page')
    await expect(
      runtime.browserTabSetProfile({ page: 'remote-page', profileId: 'missing' })
    ).rejects.toThrow('Browser profile missing was not found')
    expect(pages.getPage('remote-page')).toBe(before)
    expect(window).not.toHaveBeenCalled()
  })

  it('does not accept a page from a different explicit workspace', async () => {
    const { runtime } = fixture()
    await expect(
      runtime.browserTabSetProfile({
        page: 'remote-page',
        worktree: 'another-workspace',
        profileId: 'isolated'
      })
    ).rejects.toThrow('was not found in this worktree')
  })

  it('resolves a folder-workspace page without the server-local target path', async () => {
    const { runtime, localTarget, window } = fixture()
    await expect(
      runtime.browserTabSetProfile({ worktree: 'id:folder:workspace', profileId: 'isolated' })
    ).resolves.toMatchObject({ browserPageId: 'remote-page', profileId: 'isolated' })
    expect(localTarget).not.toHaveBeenCalled()
    expect(window).not.toHaveBeenCalled()
  })

  it('normalizes synthetic default before comparing the authoritative identity', async () => {
    const canonical = { id: 'canonical-default', label: 'Default', partition: 'persist:canonical' }
    mocks.getProfile.mockReturnValue(undefined)
    mocks.getDefaultProfile.mockReturnValue(canonical)
    const { runtime } = fixture('canonical-default')
    await expect(
      runtime.browserTabSetProfile({ page: 'remote-page', profileId: 'default' })
    ).resolves.toMatchObject({ profileId: 'canonical-default' })
  })
})
