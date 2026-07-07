import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentBrowserBridge } from '../browser/agent-browser-bridge'
import type { RuntimeBrowserCommandHost } from './orca-runtime-browser'

const {
  ipcMainOnMock,
  ipcMainRemoveListenerMock,
  webContentsFromIdMock,
  startBrowserScreencastMock,
  waitForTabRegistrationMock,
  waitForWorktreeTabRegistrationMock,
  browserSessionRegistryMock
} = vi.hoisted(() => ({
  ipcMainOnMock: vi.fn(),
  ipcMainRemoveListenerMock: vi.fn(),
  webContentsFromIdMock: vi.fn(),
  startBrowserScreencastMock: vi.fn(),
  waitForTabRegistrationMock: vi.fn(),
  waitForWorktreeTabRegistrationMock: vi.fn(),
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
    resolveKnownPartition: vi.fn()
  }
}))

vi.mock('electron', () => ({
  ipcMain: { on: ipcMainOnMock, removeListener: ipcMainRemoveListenerMock },
  webContents: { fromId: webContentsFromIdMock }
}))

vi.mock('../browser/browser-screencast-stream', () => ({
  startBrowserScreencast: startBrowserScreencastMock
}))

vi.mock('../ipc/browser', () => ({
  waitForTabRegistration: waitForTabRegistrationMock,
  waitForWorktreeTabRegistration: waitForWorktreeTabRegistrationMock
}))

vi.mock('../browser/browser-session-registry', () => ({
  browserSessionRegistry: browserSessionRegistryMock
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function createHost(overrides: Partial<RuntimeBrowserCommandHost> = {}): RuntimeBrowserCommandHost {
  const bridge =
    overrides.getAgentBrowserBridge?.() ??
    ({
      getRegisteredTabs: vi.fn(() => new Map([['page-1', 100]])),
      getActivePageId: vi.fn(() => 'page-1'),
      tabList: vi.fn(() => ({
        tabs: [
          {
            browserPageId: 'page-1',
            index: 0,
            url: 'about:blank',
            title: 'Browser',
            active: true
          }
        ]
      }))
    } as unknown as AgentBrowserBridge)
  return {
    resolveWorktreeSelector: async (selector) => ({ id: selector.replace(/^id:/, '') }),
    getAuthoritativeWindow: vi.fn(),
    getAvailableAuthoritativeWindow: vi.fn(() => null),
    getOffscreenBrowserBackend: vi.fn(() => null),
    ...overrides,
    getAgentBrowserBridge: () => bridge
  } as unknown as RuntimeBrowserCommandHost
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
  })

  it('waits for explicit worktree browser registration after requesting a hidden mount', async () => {
    const { RuntimeBrowserCommands } = await import('./orca-runtime-browser')
    const send = vi.fn()
    const bridge = {
      getRegisteredTabs: vi.fn(() => new Map()),
      tabList: vi.fn(() => ({ tabs: [] }))
    } as unknown as AgentBrowserBridge
    const commands = new RuntimeBrowserCommands(
      createHost({
        getAgentBrowserBridge: () => bridge,
        getAuthoritativeWindow: vi.fn(() => ({ webContents: { send } }) as never)
      })
    )

    await commands.browserTabList({ worktree: 'id:wt-1' })

    expect(send).toHaveBeenCalledWith('browser:activateView', { worktreeId: 'wt-1' })
    expect(waitForWorktreeTabRegistrationMock).toHaveBeenCalledWith('wt-1')
    expect(bridge.tabList).toHaveBeenCalledWith('wt-1')
  })

  it('re-wakes an explicit worktree when the only registered browser tab is stale', async () => {
    const { RuntimeBrowserCommands } = await import('./orca-runtime-browser')
    webContentsFromIdMock.mockReturnValue({ isDestroyed: () => true })
    const send = vi.fn()
    const bridge = {
      getRegisteredTabs: vi.fn(() => new Map([['page-stale', 404]])),
      tabList: vi.fn(() => ({ tabs: [] }))
    } as unknown as AgentBrowserBridge
    const commands = new RuntimeBrowserCommands(
      createHost({
        getAgentBrowserBridge: () => bridge,
        getAuthoritativeWindow: vi.fn(() => ({ webContents: { send } }) as never)
      })
    )

    await commands.browserTabList({ worktree: 'id:wt-1' })

    expect(send).toHaveBeenCalledWith('browser:activateView', { worktreeId: 'wt-1' })
    expect(waitForWorktreeTabRegistrationMock).toHaveBeenCalledWith('wt-1')
    expect(bridge.tabList).toHaveBeenCalledWith('wt-1')
  })

  it('waits for any browser registration after requesting a hidden mount without worktree scope', async () => {
    const { RuntimeBrowserCommands } = await import('./orca-runtime-browser')
    const send = vi.fn()
    const bridge = {
      getRegisteredTabs: vi.fn(() => new Map()),
      tabList: vi.fn(() => ({ tabs: [] }))
    } as unknown as AgentBrowserBridge
    const commands = new RuntimeBrowserCommands(
      createHost({
        getAgentBrowserBridge: () => bridge,
        getAuthoritativeWindow: vi.fn(() => ({ webContents: { send } }) as never)
      })
    )

    await commands.browserTabList({})

    expect(send).toHaveBeenCalledWith('browser:activateView', {})
    expect(waitForWorktreeTabRegistrationMock).toHaveBeenCalledWith(undefined)
    expect(bridge.tabList).toHaveBeenCalledWith(undefined)
  })

  it('creates the first explicit-worktree browser tab without waiting for an existing registration', async () => {
    const { RuntimeBrowserCommands } = await import('./orca-runtime-browser')
    const webContents = { send: vi.fn() }
    const send = vi.fn((channel: string, data: { requestId: string }) => {
      expect(channel).toBe('browser:requestTabCreate')
      const handler = ipcMainOnMock.mock.calls.find(
        ([eventName]) => eventName === 'browser:tabCreateReply'
      )?.[1] as
        | ((
            event: unknown,
            reply: { requestId: string; browserPageId?: string; error?: string }
          ) => void)
        | undefined
      handler?.({ sender: { send: vi.fn() } } as never, {
        requestId: data.requestId,
        error: 'spoofed renderer reply'
      })
      handler?.({ sender: webContents } as never, {
        requestId: data.requestId,
        browserPageId: 'page-new'
      })
    })
    webContents.send = send
    const bridge = {
      getRegisteredTabs: vi.fn(() => new Map([['page-new', 101]])),
      getActivePageId: vi.fn(() => 'page-new'),
      setActiveTab: vi.fn(),
      tabList: vi.fn(() => ({ tabs: [] }))
    } as unknown as AgentBrowserBridge
    const commands = new RuntimeBrowserCommands(
      createHost({
        getAgentBrowserBridge: () => bridge,
        getAvailableAuthoritativeWindow: vi.fn(() => ({}) as never),
        getAuthoritativeWindow: vi.fn(() => ({ webContents }) as never)
      })
    )

    await expect(
      commands.browserTabCreate({ worktree: 'id:wt-1', url: 'about:blank' })
    ).resolves.toEqual({ browserPageId: 'page-new' })

    expect(waitForWorktreeTabRegistrationMock).not.toHaveBeenCalled()
    // Why: with no explicit profile, main must leave sessionProfileId/
    // sessionPartition undefined so the renderer applies the user's configured
    // default-profile inheritance instead of being forced onto the shared
    // default partition.
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

  it('sends the resolved isolated profile partition when creating a renderer tab', async () => {
    const { RuntimeBrowserCommands } = await import('./orca-runtime-browser')
    const webContents = { send: vi.fn() }
    const send = vi.fn((channel: string, data: { requestId: string }) => {
      expect(channel).toBe('browser:requestTabCreate')
      const handler = ipcMainOnMock.mock.calls.find(
        ([eventName]) => eventName === 'browser:tabCreateReply'
      )?.[1] as
        | ((event: unknown, reply: { requestId: string; browserPageId?: string }) => void)
        | undefined
      handler?.({ sender: webContents } as never, {
        requestId: data.requestId,
        browserPageId: 'page-isolated'
      })
    })
    webContents.send = send
    const bridge = {
      getRegisteredTabs: vi.fn(() => new Map([['page-isolated', 101]])),
      getActivePageId: vi.fn(() => 'page-isolated'),
      setActiveTab: vi.fn(),
      tabList: vi.fn(() => ({ tabs: [] }))
    } as unknown as AgentBrowserBridge
    const commands = new RuntimeBrowserCommands(
      createHost({
        getAgentBrowserBridge: () => bridge,
        getAvailableAuthoritativeWindow: vi.fn(() => ({}) as never),
        getAuthoritativeWindow: vi.fn(() => ({ webContents }) as never)
      })
    )

    await expect(
      commands.browserTabCreate({
        worktree: 'id:wt-1',
        url: 'https://example.com',
        profileId: 'profile-isolated'
      })
    ).resolves.toEqual({ browserPageId: 'page-isolated' })

    expect(send).toHaveBeenCalledWith(
      'browser:requestTabCreate',
      expect.objectContaining({
        sessionProfileId: 'profile-isolated',
        sessionPartition: 'persist:orca-browser-session-profile-isolated'
      })
    )
  })

  it('rejects unknown explicit profile ids before requesting a renderer tab', async () => {
    const { RuntimeBrowserCommands } = await import('./orca-runtime-browser')
    const send = vi.fn()
    const commands = new RuntimeBrowserCommands(
      createHost({
        getAvailableAuthoritativeWindow: vi.fn(() => ({}) as never),
        getAuthoritativeWindow: vi.fn(() => ({ webContents: { send } }) as never)
      })
    )

    await expect(
      commands.browserTabCreate({
        worktree: 'id:wt-1',
        url: 'https://example.com',
        profileId: 'missing-profile'
      })
    ).rejects.toThrow(/Browser profile missing-profile was not found/)

    expect(send).not.toHaveBeenCalled()
  })

  it('sends the resolved partition when switching a renderer tab profile', async () => {
    const { RuntimeBrowserCommands } = await import('./orca-runtime-browser')
    const webContents = { send: vi.fn() }
    const send = vi.fn((channel: string, data: { requestId: string }) => {
      expect(channel).toBe('browser:requestTabSetProfile')
      const handler = ipcMainOnMock.mock.calls.find(
        ([eventName]) => eventName === 'browser:tabSetProfileReply'
      )?.[1] as ((event: unknown, reply: { requestId: string; error?: string }) => void) | undefined
      handler?.({ sender: webContents } as never, { requestId: data.requestId })
    })
    webContents.send = send
    const bridge = {
      getRegisteredTabs: vi.fn(() => new Map([['page-1', 101]])),
      getActivePageId: vi.fn(() => 'page-1')
    } as unknown as AgentBrowserBridge
    const commands = new RuntimeBrowserCommands(
      createHost({
        getAgentBrowserBridge: () => bridge,
        getAvailableAuthoritativeWindow: vi.fn(() => ({}) as never),
        getAuthoritativeWindow: vi.fn(() => ({ webContents }) as never)
      })
    )

    await expect(
      commands.browserTabSetProfile({ worktree: 'id:wt-1', profileId: 'profile-isolated' })
    ).resolves.toEqual({
      browserPageId: 'page-1',
      profileId: 'profile-isolated',
      profileLabel: 'Isolated'
    })

    expect(send).toHaveBeenCalledWith(
      'browser:requestTabSetProfile',
      expect.objectContaining({
        browserPageId: 'page-1',
        profileId: 'profile-isolated',
        sessionPartition: 'persist:orca-browser-session-profile-isolated'
      })
    )
    expect(waitForTabRegistrationMock).toHaveBeenCalledWith('page-1')
  })

  it('wakes the requested page instead of the first worktree tab for page-scoped commands', async () => {
    const { RuntimeBrowserCommands } = await import('./orca-runtime-browser')
    webContentsFromIdMock.mockReturnValue({ isDestroyed: () => true })
    const send = vi.fn()
    const snapshot = vi.fn(() => ({
      origin: 'about:blank',
      refs: {},
      snapshot: '(empty page)',
      browserPageId: 'page-target'
    }))
    const bridge = {
      getRegisteredTabs: vi.fn(() => new Map([['page-target', 101]])),
      getActivePageId: vi.fn(() => 'page-other'),
      snapshot
    } as unknown as AgentBrowserBridge
    const commands = new RuntimeBrowserCommands(
      createHost({
        getAgentBrowserBridge: () => bridge,
        getAuthoritativeWindow: vi.fn(() => ({ webContents: { send } }) as never)
      })
    )

    await expect(
      commands.browserSnapshot({ worktree: 'id:wt-1', page: 'page-target' })
    ).resolves.toEqual({
      origin: 'about:blank',
      refs: {},
      snapshot: '(empty page)',
      browserPageId: 'page-target'
    })

    expect(send).toHaveBeenCalledWith('browser:activateView', {
      worktreeId: 'wt-1',
      browserPageId: 'page-target'
    })
    expect(waitForTabRegistrationMock).toHaveBeenCalledWith('page-target')
    expect(waitForWorktreeTabRegistrationMock).not.toHaveBeenCalled()
    expect(snapshot).toHaveBeenCalledWith('wt-1', 'page-target')
  })

  it('wakes the requested page before showing page-scoped tab metadata', async () => {
    const { RuntimeBrowserCommands } = await import('./orca-runtime-browser')
    webContentsFromIdMock.mockReturnValue({ isDestroyed: () => true })
    const send = vi.fn()
    const bridge = {
      getRegisteredTabs: vi.fn(() => new Map([['page-target', 101]])),
      getActivePageId: vi.fn(() => 'page-other'),
      tabList: vi.fn(() => ({
        tabs: [
          {
            browserPageId: 'page-target',
            index: 1,
            url: 'about:blank',
            title: 'Target',
            active: false
          }
        ]
      }))
    } as unknown as AgentBrowserBridge
    const commands = new RuntimeBrowserCommands(
      createHost({
        getAgentBrowserBridge: () => bridge,
        getAuthoritativeWindow: vi.fn(() => ({ webContents: { send } }) as never)
      })
    )

    const result = await commands.browserTabShow({ worktree: 'id:wt-1', page: 'page-target' })

    expect(send).toHaveBeenCalledWith('browser:activateView', {
      worktreeId: 'wt-1',
      browserPageId: 'page-target'
    })
    expect(waitForTabRegistrationMock).toHaveBeenCalledWith('page-target')
    expect(waitForWorktreeTabRegistrationMock).not.toHaveBeenCalled()
    expect(result.tab.browserPageId).toBe('page-target')
  })

  it('wakes the requested page before showing page-scoped profile metadata', async () => {
    const { RuntimeBrowserCommands } = await import('./orca-runtime-browser')
    webContentsFromIdMock.mockReturnValue({ isDestroyed: () => true })
    const send = vi.fn()
    const bridge = {
      getRegisteredTabs: vi.fn(() => new Map([['page-target', 101]])),
      getActivePageId: vi.fn(() => 'page-other'),
      tabList: vi.fn(() => ({
        tabs: [
          {
            browserPageId: 'page-target',
            index: 1,
            url: 'about:blank',
            title: 'Target',
            active: false
          }
        ]
      }))
    } as unknown as AgentBrowserBridge
    const commands = new RuntimeBrowserCommands(
      createHost({
        getAgentBrowserBridge: () => bridge,
        getAuthoritativeWindow: vi.fn(() => ({ webContents: { send } }) as never)
      })
    )

    const result = await commands.browserTabProfileShow({
      worktree: 'id:wt-1',
      page: 'page-target'
    })

    expect(send).toHaveBeenCalledWith('browser:activateView', {
      worktreeId: 'wt-1',
      browserPageId: 'page-target'
    })
    expect(waitForTabRegistrationMock).toHaveBeenCalledWith('page-target')
    expect(waitForWorktreeTabRegistrationMock).not.toHaveBeenCalled()
    expect(result.browserPageId).toBe('page-target')
  })

  it('wakes the requested page before closing a page-scoped tab', async () => {
    const { RuntimeBrowserCommands } = await import('./orca-runtime-browser')
    webContentsFromIdMock.mockReturnValue({ isDestroyed: () => true })
    const send = vi.fn((channel: string, data: { requestId?: string }) => {
      if (channel !== 'browser:requestTabClose') {
        return
      }
      const handler = ipcMainOnMock.mock.calls.find(
        ([eventName]) => eventName === 'browser:tabCloseReply'
      )?.[1] as ((event: unknown, reply: { requestId: string; error?: string }) => void) | undefined
      handler?.({} as never, { requestId: data.requestId ?? '' })
    })
    const bridge = {
      getRegisteredTabs: vi.fn(() => new Map([['page-target', 101]])),
      getActivePageId: vi.fn(() => 'page-other'),
      getActiveWebContentsId: vi.fn(() => 101)
    } as unknown as AgentBrowserBridge
    const commands = new RuntimeBrowserCommands(
      createHost({
        getAgentBrowserBridge: () => bridge,
        getAuthoritativeWindow: vi.fn(() => ({ webContents: { send } }) as never)
      })
    )

    await expect(
      commands.browserTabClose({ worktree: 'id:wt-1', page: 'page-target' })
    ).resolves.toEqual({ closed: true })

    expect(send).toHaveBeenCalledWith('browser:activateView', {
      worktreeId: 'wt-1',
      browserPageId: 'page-target'
    })
    expect(waitForTabRegistrationMock).toHaveBeenCalledWith('page-target')
    expect(waitForWorktreeTabRegistrationMock).not.toHaveBeenCalled()
    expect(send).toHaveBeenCalledWith(
      'browser:requestTabClose',
      expect.objectContaining({ tabId: 'page-target', worktreeId: 'wt-1' })
    )
  })

  it('lets a new same-page stream take over an active stale stream', async () => {
    const { RuntimeBrowserCommands } = await import('./orca-runtime-browser')
    webContentsFromIdMock.mockReturnValue({ isDestroyed: () => false })
    const firstDone = deferred<void>()
    const secondDone = deferred<void>()
    const firstStop = vi.fn(() => firstDone.resolve())
    const secondStop = vi.fn(() => secondDone.resolve())
    startBrowserScreencastMock
      .mockResolvedValueOnce({ stop: firstStop, done: firstDone.promise })
      .mockResolvedValueOnce({ stop: secondStop, done: secondDone.promise })

    const commands = new RuntimeBrowserCommands(createHost())
    const first = await commands.browserScreencast(
      { worktree: 'id:wt-1', page: 'page-1', format: 'jpeg' },
      { sendBinary: vi.fn() }
    )

    const secondPromise = commands.browserScreencast(
      { worktree: 'id:wt-1', page: 'page-1', format: 'jpeg' },
      { sendBinary: vi.fn() }
    )

    await vi.waitFor(() => expect(firstStop).toHaveBeenCalledTimes(1))
    const second = await secondPromise

    expect(startBrowserScreencastMock).toHaveBeenCalledTimes(2)
    expect(first.subscriptionId).not.toBe(second.subscriptionId)
    second.session.stop()
    await second.session.done
    expect(secondStop).toHaveBeenCalledTimes(1)
  }, 10_000)
})

describe('RuntimeBrowserCommands headless offscreen routing', () => {
  beforeEach(() => {
    ipcMainOnMock.mockReset()
    webContentsFromIdMock.mockReset()
    waitForTabRegistrationMock.mockReset()
    waitForTabRegistrationMock.mockResolvedValue(undefined)
    waitForWorktreeTabRegistrationMock.mockReset()
    waitForWorktreeTabRegistrationMock.mockResolvedValue(undefined)
  })

  it('routes tab creation to the offscreen backend when no renderer window exists', async () => {
    const { RuntimeBrowserCommands } = await import('./orca-runtime-browser')
    const createTab = vi.fn(async () => ({ browserPageId: 'page-offscreen' }))
    const setActiveTab = vi.fn()
    const bridge = {
      getRegisteredTabs: vi.fn(() => new Map([['page-offscreen', 202]])),
      setActiveTab
    } as unknown as AgentBrowserBridge
    const commands = new RuntimeBrowserCommands(
      createHost({
        getAgentBrowserBridge: () => bridge,
        getAvailableAuthoritativeWindow: vi.fn(() => null),
        getOffscreenBrowserBackend: vi.fn(() => ({ createTab, closeTab: vi.fn() }))
      })
    )

    await expect(
      commands.browserTabCreate({ worktree: 'id:wt-1', url: 'https://example.com' })
    ).resolves.toEqual({ browserPageId: 'page-offscreen' })

    expect(createTab).toHaveBeenCalledWith({
      url: 'https://example.com',
      worktreeId: 'wt-1',
      profileId: undefined
    })
    // No renderer round-trip in headless mode.
    expect(waitForTabRegistrationMock).not.toHaveBeenCalled()
    expect(setActiveTab).toHaveBeenCalledWith(202, 'wt-1')
  })

  it('rejects tab creation when neither a renderer nor an offscreen backend is available', async () => {
    const { RuntimeBrowserCommands } = await import('./orca-runtime-browser')
    const commands = new RuntimeBrowserCommands(
      createHost({
        getAvailableAuthoritativeWindow: vi.fn(() => null),
        getOffscreenBrowserBackend: vi.fn(() => null)
      })
    )

    await expect(commands.browserTabCreate({ url: 'about:blank' })).rejects.toThrow(
      /does not support browser panes/
    )
  })

  it('closes a headless tab via the offscreen backend without a renderer round-trip', async () => {
    const { RuntimeBrowserCommands } = await import('./orca-runtime-browser')
    webContentsFromIdMock.mockReturnValue({ isDestroyed: () => false })
    const closeTab = vi.fn(async () => {})
    const bridge = {
      getRegisteredTabs: vi.fn(() => new Map([['page-offscreen', 202]])),
      getActivePageId: vi.fn(() => 'page-offscreen'),
      getActiveWebContentsId: vi.fn(() => 202)
    } as unknown as AgentBrowserBridge
    const commands = new RuntimeBrowserCommands(
      createHost({
        getAgentBrowserBridge: () => bridge,
        getAvailableAuthoritativeWindow: vi.fn(() => null),
        getOffscreenBrowserBackend: vi.fn(() => ({ createTab: vi.fn(), closeTab }))
      })
    )

    await expect(
      commands.browserTabClose({ worktree: 'id:wt-1', page: 'page-offscreen' })
    ).resolves.toEqual({ closed: true })

    expect(closeTab).toHaveBeenCalledWith('page-offscreen')
    // The renderer close IPC must not be used in headless mode.
    expect(ipcMainOnMock).not.toHaveBeenCalledWith('browser:tabCloseReply', expect.anything())
  })

  it('closes the active headless tab on an implicit close', async () => {
    const { RuntimeBrowserCommands } = await import('./orca-runtime-browser')
    webContentsFromIdMock.mockReturnValue({ isDestroyed: () => false })
    const closeTab = vi.fn(async () => {})
    const bridge = {
      getRegisteredTabs: vi.fn(() => new Map([['page-active', 303]])),
      getActivePageId: vi.fn(() => 'page-active'),
      getActiveWebContentsId: vi.fn(() => 303)
    } as unknown as AgentBrowserBridge
    const commands = new RuntimeBrowserCommands(
      createHost({
        getAgentBrowserBridge: () => bridge,
        getAvailableAuthoritativeWindow: vi.fn(() => null),
        getOffscreenBrowserBackend: vi.fn(() => ({ createTab: vi.fn(), closeTab }))
      })
    )

    // No --page / --index: resolves the active page rather than no-op succeeding.
    await expect(commands.browserTabClose({ worktree: 'id:wt-1' })).resolves.toEqual({
      closed: true
    })
    expect(closeTab).toHaveBeenCalledWith('page-active')
  })

  it('reports not-closed (no false success) when no headless tab can be resolved', async () => {
    const { RuntimeBrowserCommands } = await import('./orca-runtime-browser')
    const closeTab = vi.fn(async () => {})
    const bridge = {
      getRegisteredTabs: vi.fn(() => new Map()),
      getActivePageId: vi.fn(() => null),
      getActiveWebContentsId: vi.fn(() => null)
    } as unknown as AgentBrowserBridge
    const commands = new RuntimeBrowserCommands(
      createHost({
        getAgentBrowserBridge: () => bridge,
        getAvailableAuthoritativeWindow: vi.fn(() => null),
        getOffscreenBrowserBackend: vi.fn(() => ({ createTab: vi.fn(), closeTab }))
      })
    )

    await expect(commands.browserTabClose({ worktree: 'id:wt-1' })).resolves.toEqual({
      closed: false
    })
    expect(closeTab).not.toHaveBeenCalled()
  })

  it('forwards an unresolved worktree to the bridge unchanged for keyboard inserttext', async () => {
    const { RuntimeBrowserCommands } = await import('./orca-runtime-browser')
    // Why: when no --worktree is passed (or cwd is outside a managed worktree),
    // worktreeId arrives undefined. The bridge — not the runtime — owns the
    // cross-worktree guard, so verify the undefined scope is threaded through
    // intact rather than silently widened here.
    const keyboardInsertText = vi.fn().mockResolvedValue({ inserted: true })
    const bridge = {
      getRegisteredTabs: vi.fn(() => new Map([['page-1', 100]])),
      keyboardInsertText
    } as unknown as AgentBrowserBridge
    const commands = new RuntimeBrowserCommands(
      createHost({
        getAgentBrowserBridge: () => bridge,
        getAuthoritativeWindow: vi.fn(() => ({ webContents: { send: vi.fn() } }) as never)
      })
    )

    await commands.browserKeyboardInsertText({ text: 'hello' })

    expect(keyboardInsertText).toHaveBeenCalledWith('hello', undefined, undefined)
  })
})
