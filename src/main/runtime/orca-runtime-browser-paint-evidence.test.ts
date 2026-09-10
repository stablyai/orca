import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentBrowserBridge } from '../browser/agent-browser-bridge'
import type { RuntimeBrowserCommandHost } from './orca-runtime-browser'

const { ipcMainOnMock, webContentsFromIdMock, waitForTabRegistrationMock } = vi.hoisted(() => ({
  ipcMainOnMock: vi.fn(),
  webContentsFromIdMock: vi.fn(),
  waitForTabRegistrationMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: { on: ipcMainOnMock, removeListener: vi.fn() },
  webContents: { fromId: webContentsFromIdMock }
}))
vi.mock('../browser/browser-screencast-stream', () => ({ startBrowserScreencast: vi.fn() }))
vi.mock('../ipc/browser-tab-registration-wait', () => ({
  waitForTabRegistration: waitForTabRegistrationMock,
  waitForWorktreeTabRegistration: vi.fn()
}))
vi.mock('../browser/browser-session-registry', () => ({
  browserSessionRegistry: { resolveKnownPartition: () => 'persist:orca-browser' }
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

describe('browser tab creation paint evidence', () => {
  beforeEach(() => {
    ipcMainOnMock.mockReset()
    webContentsFromIdMock.mockReset()
    waitForTabRegistrationMock.mockReset()
    waitForTabRegistrationMock.mockResolvedValue(undefined)
  })

  it('reports paint as unobserved when it returns before navigation settles', async () => {
    const { RuntimeBrowserCommands } = await import('./orca-runtime-browser')
    const navigation = deferred<{ title: string; url: string }>()
    const capturePage = vi.fn(async () => ({ isEmpty: () => true }))
    webContentsFromIdMock.mockReturnValue({ isDestroyed: () => false, capturePage })
    const webContents = { send: vi.fn() }
    webContents.send = vi.fn((_channel: string, data: { requestId: string }) => {
      const handler = ipcMainOnMock.mock.calls.find(
        ([eventName]) => eventName === 'browser:tabCreateReply'
      )?.[1] as
        | ((event: unknown, reply: { requestId: string; browserPageId?: string }) => void)
        | undefined
      handler?.({ sender: webContents } as never, {
        requestId: data.requestId,
        browserPageId: 'page-unpainted'
      })
    })
    const bridge = {
      getRegisteredTabs: vi.fn(() => new Map([['page-unpainted', 101]])),
      getActivePageId: vi.fn(() => 'page-unpainted'),
      goto: vi.fn(() => navigation.promise),
      setActiveTab: vi.fn()
    } as unknown as AgentBrowserBridge
    const commands = new RuntimeBrowserCommands({
      resolveWorktreeSelector: async (selector: string) => ({ id: selector.replace(/^id:/, '') }),
      getAgentBrowserBridge: () => bridge,
      getAvailableAuthoritativeWindow: vi.fn(() => ({ isVisible: () => true })),
      getAuthoritativeWindow: vi.fn(() => ({ webContents })),
      getOffscreenBrowserBackend: vi.fn(() => null)
    } as unknown as RuntimeBrowserCommandHost)

    let created: Awaited<ReturnType<typeof commands.browserTabCreate>> | null = null
    const creation = commands
      .browserTabCreate({
        worktree: 'id:wt-1',
        url: 'https://example.com/slow',
        waitForRegistration: true,
        focus: true
      })
      .then((result) => {
        created = result
        return result
      })
    await vi.waitFor(() => expect(bridge.goto).toHaveBeenCalledOnce())
    await new Promise<void>((resolve) => setImmediate(resolve))

    try {
      // The page is still on about:blank here, so probing it would only prove the blank page blank.
      expect(capturePage).not.toHaveBeenCalled()
      expect(created).toMatchObject({
        browserPageId: 'page-unpainted',
        focusReceipt: { requested: true, nativePanePaint: 'unobserved', observedAt: null }
      })
    } finally {
      navigation.resolve({ title: 'Slow page', url: 'https://example.com/slow' })
      await creation
    }
  })
})
