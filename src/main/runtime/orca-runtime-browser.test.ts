/* eslint-disable max-lines -- Why: browser runtime command tests share one
mocked BrowserManager/agent-browser bridge so page wake and registration
ordering regressions stay in one boundary-focused suite. */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentBrowserBridge } from '../browser/agent-browser-bridge'
import type { RuntimeBrowserCommandHost } from './orca-runtime-browser'

const {
  ipcMainOnMock,
  ipcMainRemoveListenerMock,
  webContentsFromIdMock,
  startBrowserScreencastMock,
  waitForTabRegistrationMock,
  waitForWorktreeTabRegistrationMock
} = vi.hoisted(() => ({
  ipcMainOnMock: vi.fn(),
  ipcMainRemoveListenerMock: vi.fn(),
  webContentsFromIdMock: vi.fn(),
  startBrowserScreencastMock: vi.fn(),
  waitForTabRegistrationMock: vi.fn(),
  waitForWorktreeTabRegistrationMock: vi.fn()
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
      handler?.({} as never, { requestId: data.requestId, browserPageId: 'page-new' })
    })
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
        getAuthoritativeWindow: vi.fn(() => ({ webContents: { send } }) as never)
      })
    )

    await expect(
      commands.browserTabCreate({ worktree: 'id:wt-1', url: 'about:blank' })
    ).resolves.toEqual({ browserPageId: 'page-new' })

    expect(waitForWorktreeTabRegistrationMock).not.toHaveBeenCalled()
    expect(send).toHaveBeenCalledWith(
      'browser:requestTabCreate',
      expect.objectContaining({ url: 'about:blank', worktreeId: 'wt-1' })
    )
    expect(waitForTabRegistrationMock).toHaveBeenCalledWith('page-new')
    expect(bridge.setActiveTab).toHaveBeenCalledWith(101, 'wt-1')
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
