import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentBrowserBridge } from '../browser/agent-browser-bridge'
import type { RuntimeBrowserCommandHost } from './orca-runtime-browser'

const { webContentsFromIdMock, startBrowserScreencastMock, waitForWorktreeTabRegistrationMock } =
  vi.hoisted(() => ({
    webContentsFromIdMock: vi.fn(),
    startBrowserScreencastMock: vi.fn(),
    waitForWorktreeTabRegistrationMock: vi.fn()
  }))

vi.mock('electron', () => ({
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  webContents: { fromId: webContentsFromIdMock }
}))

vi.mock('../browser/browser-screencast-stream', () => ({
  startBrowserScreencast: startBrowserScreencastMock
}))

vi.mock('../ipc/browser', () => ({
  waitForTabRegistration: vi.fn(),
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
    webContentsFromIdMock.mockReset()
    startBrowserScreencastMock.mockReset()
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
