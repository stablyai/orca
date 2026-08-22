import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentBrowserBridge } from '../browser/agent-browser-bridge'
import type { RuntimeBrowserCommandHost } from './orca-runtime-browser'

const {
  ipcMainOnMock,
  ipcMainRemoveListenerMock,
  waitForTabRegistrationMock,
  browserSessionRegistryMock
} = vi.hoisted(() => ({
  ipcMainOnMock: vi.fn(),
  ipcMainRemoveListenerMock: vi.fn(),
  waitForTabRegistrationMock: vi.fn(),
  browserSessionRegistryMock: {
    resolveKnownPartition: vi.fn(() => 'persist:orca-browser')
  }
}))

vi.mock('electron', () => ({
  ipcMain: { on: ipcMainOnMock, removeListener: ipcMainRemoveListenerMock },
  webContents: { fromId: vi.fn() }
}))

vi.mock('../ipc/browser', () => ({
  waitForTabRegistration: waitForTabRegistrationMock,
  waitForWorktreeTabRegistration: vi.fn()
}))

vi.mock('../browser/browser-session-registry', () => ({
  browserSessionRegistry: browserSessionRegistryMock
}))

function createHost(overrides: Partial<RuntimeBrowserCommandHost> = {}): RuntimeBrowserCommandHost {
  return {
    getAgentBrowserBridge: () => null,
    resolveWorktreeSelector: async (selector: string) => ({
      id: selector.startsWith('id:') ? selector.slice(3) : selector
    }),
    getAuthoritativeWindow: vi.fn(),
    getAvailableAuthoritativeWindow: vi.fn(() => null),
    getOffscreenBrowserBackend: () => null,
    ...overrides
  }
}

describe('RuntimeBrowserCommands hosted tab create', () => {
  beforeEach(() => {
    ipcMainOnMock.mockReset()
    ipcMainRemoveListenerMock.mockReset()
    waitForTabRegistrationMock.mockReset()
    waitForTabRegistrationMock.mockResolvedValue(undefined)
    browserSessionRegistryMock.resolveKnownPartition.mockReturnValue('persist:orca-browser')
  })

  it('skips local webview registration when the renderer reports a remotely hosted tab', async () => {
    const { RuntimeBrowserCommands } = await import('./orca-runtime-browser')
    const webContents = { send: vi.fn() }
    const send = vi.fn((channel: string, data: { requestId: string }) => {
      expect(channel).toBe('browser:requestTabCreate')
      const handler = ipcMainOnMock.mock.calls.find(
        ([eventName]) => eventName === 'browser:tabCreateReply'
      )?.[1] as
        | ((
            event: unknown,
            reply: {
              requestId: string
              browserPageId?: string
              hostedRemotely?: boolean
            }
          ) => void)
        | undefined
      handler?.({ sender: webContents } as never, {
        requestId: data.requestId,
        browserPageId: 'remote-page-1',
        hostedRemotely: true
      })
    })
    webContents.send = send
    const bridge = {
      getRegisteredTabs: vi.fn(() => new Map()),
      getActivePageId: vi.fn(() => null),
      setActiveTab: vi.fn(),
      goto: vi.fn()
    } as unknown as AgentBrowserBridge
    const commands = new RuntimeBrowserCommands(
      createHost({
        getAgentBrowserBridge: () => bridge,
        getAvailableAuthoritativeWindow: vi.fn(() => ({}) as never),
        getAuthoritativeWindow: vi.fn(() => ({ webContents }) as never)
      })
    )

    await expect(
      commands.browserTabCreate({ worktree: 'id:wt-remote', url: 'https://example.com' })
    ).resolves.toEqual({ browserPageId: 'remote-page-1' })

    expect(waitForTabRegistrationMock).not.toHaveBeenCalled()
    expect(bridge.goto).not.toHaveBeenCalled()
    expect(bridge.setActiveTab).not.toHaveBeenCalled()
  })
})
