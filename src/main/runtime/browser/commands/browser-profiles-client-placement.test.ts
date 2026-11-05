import { BrowserHostLeaseRegistry } from '../../browser-host/leases/browser-host-lease-registry'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RuntimeBrowserPageRegistry } from '../client-pages/runtime-browser-page-registry'

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
vi.mock('../../../browser/sessions/browser-session-registry', () => ({
  browserSessionRegistry: {
    getProfile: mocks.getProfile,
    getDefaultProfile: mocks.getDefaultProfile
  }
}))
vi.mock('../../../browser/browser-manager', () => ({
  browserManager: { getSessionProfileIdForTab: mocks.getLocalProfile }
}))
vi.mock('../../../ipc/browser/browser-tab-registration-wait', () => ({
  waitForTabRegistration: mocks.wait
}))
import { RuntimeBrowserProfiles } from './browser-profiles'
import { RuntimeBrowserTabCatalog } from '../tabs/browser-tab-catalog'

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
      getRuntimeId: () => 'owner',
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
})
