import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentBrowserBridge } from '../../../browser/agent-browser/agent-browser-bridge'
import type { RuntimeBrowserCommandHost } from '../commands/browser-command-contracts'
import { RuntimeBrowserPageRegistry } from './runtime-browser-page-registry'
import { BrowserHostLeaseRegistry } from '../../browser-host/leases/browser-host-lease-registry'
import { BrowserHostRequestRegistry } from '../../browser-host/leases/browser-host-request-registry'
import { setRuntimeDesktopSurface } from '../../construction/runtime-desktop-surface'
import {
  rendererWindowSurfaceForTest,
  TEST_RENDERER_WINDOW_ID
} from '../../construction/renderer-window-surface-test-double'

const {
  ipcMainOnMock,
  ipcMainRemoveListenerMock,
  webContentsFromIdMock,
  startBrowserScreencastMock,
  waitForTabRegistrationMock,
  waitForWorktreeTabRegistrationMock,
  whenBrowserMainWindowReadyMock,
  browserSessionRegistryMock
} = vi.hoisted(() => ({
  ipcMainOnMock:
    vi.fn<
      (
        channel: string,
        listener: (
          event: { sender: unknown },
          reply: { requestId: string; browserPageId?: string; error?: string }
        ) => void
      ) => void
    >(),
  ipcMainRemoveListenerMock: vi.fn(),
  webContentsFromIdMock: vi.fn(),
  startBrowserScreencastMock: vi.fn(),
  waitForTabRegistrationMock: vi.fn(),
  waitForWorktreeTabRegistrationMock: vi.fn(),
  whenBrowserMainWindowReadyMock: vi.fn(),
  browserSessionRegistryMock: {
    profiles: new Map([
      [
        'default',
        {
          id: 'default',
          scope: 'default',
          partition: 'persist:orca-browser',
          label: 'Default',
          source: null
        }
      ],
      [
        'profile-isolated',
        {
          id: 'profile-isolated',
          scope: 'isolated',
          partition: 'persist:orca-browser-session-profile-isolated',
          label: 'Isolated',
          source: null
        }
      ]
    ]),
    getDefaultProfile: vi.fn(),
    getProfile: vi.fn(),
    resolveKnownPartition: vi.fn(),
    createProfile: vi.fn()
  }
}))

vi.mock('electron', () => ({
  ipcMain: { on: ipcMainOnMock, removeListener: ipcMainRemoveListenerMock },
  webContents: { fromId: webContentsFromIdMock }
}))

vi.mock('../../../browser/cdp/screencast/browser-screencast-stream', () => ({
  startBrowserScreencast: startBrowserScreencastMock
}))

vi.mock('../../../ipc/browser/browser-tab-registration-wait', () => ({
  waitForTabRegistration: waitForTabRegistrationMock,
  waitForWorktreeTabRegistration: waitForWorktreeTabRegistrationMock
}))

vi.mock('../../../browser/guest-lifecycle/browser-main-window-readiness', () => ({
  whenBrowserMainWindowReady: whenBrowserMainWindowReadyMock
}))

vi.mock('../../../browser/sessions/profiles/browser-session-registry', () => ({
  browserSessionRegistry: browserSessionRegistryMock
}))

function createHost(overrides: Partial<RuntimeBrowserCommandHost> = {}): RuntimeBrowserCommandHost {
  const runtimeBrowserPages = new RuntimeBrowserPageRegistry()
  const bridge = vi.mockObject(AgentBrowserBridge.prototype)
  bridge.getRegisteredTabs.mockReturnValue(new Map([['page-1', 100]]))
  bridge.getRegisteredPageWebContentsId.mockImplementation((page) =>
    page === 'page-1' ? 100 : undefined
  )
  bridge.getActivePageId.mockReturnValue('page-1')
  bridge.tabList.mockReturnValue({
    tabs: [
      { browserPageId: 'page-1', index: 0, url: 'about:blank', title: 'Browser', active: true }
    ]
  })
  return {
    getRuntimeId: () => 'host',
    resolveBrowserNetworkExecutionHost: () => ({ kind: 'native', runtimeId: 'host', revision: 0 }),
    resolveWorkspaceSelector: async (selector) => ({ id: selector.replace(/^id:/, '') }),
    resolveBrowserWorkspace: async (selector) => ({ id: selector.replace(/^id:/, '') }),
    getRuntimeBrowserPageRegistry: () => runtimeBrowserPages,
    // No paired desktop: headless creates stay on this host.
    getBrowserHostLeaseRegistry: () => new BrowserHostLeaseRegistry({ authorityRuntimeId: 'host' }),
    getBrowserHostRequestRegistry: () => new BrowserHostRequestRegistry(),
    getAuthoritativeWindowId: vi.fn<RuntimeBrowserCommandHost['getAuthoritativeWindowId']>(),
    getAvailableAuthoritativeWindowId: vi.fn(() => null),
    getOffscreenBrowserBackend: vi.fn(() => null),
    getAgentBrowserBridge: () => bridge,
    ...overrides
  }
}

describe('RuntimeBrowserCommands browser screencast', () => {
  beforeEach(() => {
    ipcMainOnMock.mockReset()
    ipcMainRemoveListenerMock.mockReset()
    webContentsFromIdMock.mockReset()
    startBrowserScreencastMock.mockReset()
    waitForTabRegistrationMock.mockReset()
    waitForTabRegistrationMock.mockResolvedValue(undefined)
    waitForWorktreeTabRegistrationMock.mockReset()
    waitForWorktreeTabRegistrationMock.mockResolvedValue(undefined)
    whenBrowserMainWindowReadyMock.mockReset()
    whenBrowserMainWindowReadyMock.mockResolvedValue(null)
    browserSessionRegistryMock.getDefaultProfile.mockReset()
    browserSessionRegistryMock.getDefaultProfile.mockImplementation(() =>
      browserSessionRegistryMock.profiles.get('default')
    )
    browserSessionRegistryMock.getProfile.mockReset()
    browserSessionRegistryMock.getProfile.mockImplementation(
      (profileId: string) => browserSessionRegistryMock.profiles.get(profileId) ?? null
    )
    browserSessionRegistryMock.resolveKnownPartition.mockReset()
    browserSessionRegistryMock.resolveKnownPartition.mockImplementation(
      (profileId: string | null | undefined) => {
        if (!profileId) {
          return 'persist:orca-browser'
        }
        return browserSessionRegistryMock.profiles.get(profileId)?.partition ?? null
      }
    )
    browserSessionRegistryMock.createProfile.mockReset()
  })

  it('creates the first explicit-worktree browser tab without waiting for an existing registration', async () => {
    const { RuntimeBrowserCommands } = await import('../commands/browser-commands')
    const webContents = { send: vi.fn() }
    const send = vi.fn((channel: string, data: { requestId: string }) => {
      expect(channel).toBe('browser:requestTabCreate')
      const handler = ipcMainOnMock.mock.calls.find(
        ([eventName]) => eventName === 'browser:tabCreateReply'
      )?.[1]
      handler?.(
        { sender: { send: vi.fn() } },
        {
          requestId: data.requestId,
          error: 'spoofed renderer reply'
        }
      )
      handler?.(
        { sender: webContents },
        {
          requestId: data.requestId,
          browserPageId: 'page-new'
        }
      )
    })
    webContents.send = send
    const bridge = vi.mockObject(AgentBrowserBridge.prototype)
    bridge.getRegisteredTabs.mockReturnValue(new Map([['page-new', 101]]))
    bridge.getRegisteredPageWebContentsId.mockImplementation((page) =>
      page === 'page-new' ? 101 : undefined
    )
    bridge.getActivePageId.mockReturnValue('page-new')
    bridge.tabList.mockReturnValue({ tabs: [] })
    setRuntimeDesktopSurface(
      rendererWindowSurfaceForTest(webContents, {
        on: ipcMainOnMock,
        removeListener: ipcMainRemoveListenerMock
      })
    )
    const commands = new RuntimeBrowserCommands(
      createHost({
        getAgentBrowserBridge: () => bridge,
        getAvailableAuthoritativeWindowId: () => TEST_RENDERER_WINDOW_ID,
        getAuthoritativeWindowId: () => TEST_RENDERER_WINDOW_ID
      })
    )

    await expect(
      commands.browserTabCreate({ worktree: 'id:wt-1', url: 'about:blank' })
    ).resolves.toEqual({ browserPageId: 'page-new' })

    expect(waitForWorktreeTabRegistrationMock).not.toHaveBeenCalled()
    // Leave profile/partition absent so renderer default-profile inheritance applies.
    expect(send).toHaveBeenCalledWith(
      'browser:requestTabCreate',
      expect.objectContaining({
        url: 'about:blank',
        worktreeId: 'wt-1',
        sessionProfileId: undefined,
        sessionPartition: undefined
      })
    )
    expect(waitForTabRegistrationMock).toHaveBeenCalledWith('page-new')
    expect(bridge.setActiveTab).toHaveBeenCalledWith(101, 'wt-1')
  })
  // Pageless agent commands prefer an active client page; an agent's new server tab must take that over.
  it('moves the workspace selection off a client page when a server tab is created', async () => {
    const { RuntimeBrowserCommands } = await import('../commands/browser-commands')
    const pages = new RuntimeBrowserPageRegistry()
    pages.publishClientPage({
      browserPageId: 'user-page',
      workspaceId: 'wt-1',
      browserProfileId: 'default',
      executionHostKey: 'local',
      placement: {
        kind: 'client',
        browserHostClientId: 'desktop-1',
        browserHostGeneration: 1,
        pageHostGeneration: 1
      },
      url: 'https://user.example/',
      loading: false,
      active: true
    })
    const bridge = vi.mockObject(AgentBrowserBridge.prototype)
    bridge.getRegisteredTabs.mockReturnValue(new Map([['agent-page', 102]]))
    bridge.getRegisteredPageWebContentsId.mockImplementation((page) =>
      page === 'agent-page' ? 102 : undefined
    )
    const host = createHost({
      getAgentBrowserBridge: () => bridge,
      getRuntimeBrowserPageRegistry: () => pages,
      getOffscreenBrowserBackend: () => ({
        createTab: vi.fn(async () => ({ browserPageId: 'agent-page' })),
        closeTab: vi.fn(async () => {}),
        ownsTab: () => false
      })
    })
    const commands = new RuntimeBrowserCommands(host)

    await commands.browserTabCreate({ worktree: 'id:wt-1', url: 'https://agent.example/' })

    expect(bridge.setActiveTab).toHaveBeenCalledWith(102, 'wt-1')
    expect(pages.listPages('wt-1').find((page) => page.active)).toBeUndefined()
  })
  it('reports the profile of a page a paired desktop hosts', async () => {
    const { RuntimeBrowserCommands } = await import('../commands/browser-commands')
    const pages = new RuntimeBrowserPageRegistry()
    pages.publishClientPage({
      browserPageId: 'desktop-page',
      workspaceId: 'wt-1',
      browserProfileId: 'profile-isolated',
      executionHostKey: 'local',
      placement: {
        kind: 'client',
        browserHostClientId: 'desktop-1',
        browserHostGeneration: 1,
        pageHostGeneration: 1
      },
      url: 'https://user.example/',
      loading: false,
      active: false
    })
    const commands = new RuntimeBrowserCommands(
      createHost({ getRuntimeBrowserPageRegistry: () => pages })
    )

    await expect(commands.browserTabProfileShow({ page: 'desktop-page' })).resolves.toEqual({
      browserPageId: 'desktop-page',
      worktreeId: 'wt-1',
      profileId: 'profile-isolated',
      profileLabel: 'Isolated'
    })
  })

  it('clones a tab into the offscreen browser of a host without a window', async () => {
    const { RuntimeBrowserCommands } = await import('../commands/browser-commands')
    const bridge = vi.mockObject(AgentBrowserBridge.prototype)
    bridge.getRegisteredTabs.mockReturnValue(new Map([['page-1', 100]]))
    bridge.getRegisteredPageWebContentsId.mockImplementation((page) =>
      page === 'page-1' ? 100 : undefined
    )
    bridge.tabList.mockReturnValue({
      tabs: [
        {
          browserPageId: 'page-1',
          index: 0,
          url: 'https://source.example/',
          title: 'Source',
          active: true
        }
      ]
    })
    webContentsFromIdMock.mockReturnValue({
      id: 100,
      isDestroyed: () => false,
      isLoadingMainFrame: () => false
    })
    const createTab = vi.fn(async () => ({ browserPageId: 'clone-page' }))
    const commands = new RuntimeBrowserCommands(
      createHost({
        getAgentBrowserBridge: () => bridge,
        getOffscreenBrowserBackend: () => ({
          createTab,
          closeTab: vi.fn(async () => {}),
          ownsTab: () => false
        })
      })
    )

    await expect(
      commands.browserTabProfileClone({
        page: 'page-1',
        worktree: 'id:wt-1',
        profileId: 'profile-isolated'
      })
    ).resolves.toEqual({
      browserPageId: 'clone-page',
      sourceBrowserPageId: 'page-1',
      profileId: 'profile-isolated',
      profileLabel: 'Isolated'
    })
    expect(createTab).toHaveBeenCalledWith({
      url: 'https://source.example/',
      worktreeId: 'wt-1',
      profileId: 'profile-isolated'
    })
  })
})
