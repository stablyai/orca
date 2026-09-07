import { vi, type Mock } from 'vitest'
import type { BrowserManager } from './browser-manager'

export type ExecFileCallback = (error: unknown, stdout?: string, stderr?: string) => void

export type AgentBrowserBridgeMocks = {
  webContentsFromIdMock: Mock
  existsSyncMock: Mock
  readFileSyncMock: Mock
  stdinWrites: string[]
  cdpWsProxyInstances: unknown[]
}

export function mockBrowserManager(
  tabs = new Map<string, number>([['tab-1', 100]]),
  worktrees = new Map<string, string>(),
  overrides: Partial<BrowserManager> = {}
): BrowserManager {
  return {
    getWebContentsIdByTabId: () => tabs,
    getTabIdForWebContentsId: (webContentsId: number) => {
      for (const [tabId, tabWebContentsId] of tabs) {
        if (tabWebContentsId === webContentsId) {
          return tabId
        }
      }
      return null
    },
    getWorktreeIdForTab: (tabId: string) => worktrees.get(tabId),
    getGuestWebContentsId: vi.fn(() => null),
    getBrowserPageLoadError: vi.fn(() => null),
    getBrowserPageCertificateFailure: vi.fn(() => null),
    unregisterGuest: vi.fn(),
    ensureWebviewVisible: vi.fn(async () => () => {}),
    acquireAutomationVisibility: vi.fn(async () => () => {}),
    ...overrides
  } as unknown as BrowserManager
}

type MockEmitterListener = (...args: never[]) => void

export type MockWebContentsDebugger = {
  isAttached: Mock<() => boolean>
  attach: Mock<(protocolVersion?: string) => void>
  detach: Mock<() => void>
  sendCommand: Mock<(method: string, commandParams?: unknown) => Promise<unknown>>
  on: Mock<(event: string, listener: MockEmitterListener) => void>
  removeListener: Mock<(event: string, listener: MockEmitterListener) => void>
}

export type MockWebContents = {
  id: number
  getURL: () => string
  getTitle: () => string
  loadURL: Mock<(nextUrl: string) => Promise<void>>
  isLoading: Mock<() => boolean>
  on: Mock<(event: string, listener: MockEmitterListener) => void>
  removeListener: Mock<(event: string, listener: MockEmitterListener) => void>
  isDestroyed: () => boolean
  invalidate: Mock<() => void>
  focus: Mock<() => void>
  debugger: MockWebContentsDebugger
}

export function mockWebContents(
  id: number,
  url = 'https://example.com',
  title = 'Example'
): MockWebContents {
  let currentUrl = url
  return {
    id,
    getURL: () => currentUrl,
    getTitle: () => title,
    loadURL: vi.fn(async (nextUrl: string) => {
      currentUrl = nextUrl
    }),
    isLoading: vi.fn(() => false),
    on: vi.fn(),
    removeListener: vi.fn(),
    isDestroyed: () => false,
    invalidate: vi.fn(),
    focus: vi.fn(),
    debugger: {
      isAttached: vi.fn(() => true),
      attach: vi.fn(),
      detach: vi.fn(),
      sendCommand: vi.fn(),
      on: vi.fn(),
      removeListener: vi.fn()
    }
  }
}

// Why: the bridge resolves webContents via dynamic require('electron').webContents.fromId
// inside a try/catch. Override the private method to inject our mock.
export function overrideBridgeWebContentsLookup(
  bridgePrototype: object,
  webContentsFromIdMock: Mock
): void {
  ;(bridgePrototype as { getWebContents: (id: number) => unknown }).getWebContents = function (
    id: number
  ) {
    const target = webContentsFromIdMock(id) as { isDestroyed: () => boolean } | null
    return target && !target.isDestroyed() ? target : null
  }
}

export function createSucceedWith(execFileMock: Mock, stdinWrites: string[]) {
  return function succeedWith(data: unknown): void {
    execFileMock.mockImplementation(
      (_bin: string, _args: string[], _opts: unknown, cb: ExecFileCallback) => {
        cb(null, JSON.stringify({ success: true, data }), '')
        return {
          stdin: { on: vi.fn(), end: (text: string) => stdinWrites.push(text) }
        }
      }
    )
  }
}

export function resetAgentBrowserBridgeMocks(mocks: AgentBrowserBridgeMocks): void {
  vi.clearAllMocks()
  mocks.stdinWrites.length = 0
  mocks.cdpWsProxyInstances.length = 0
  mocks.existsSyncMock.mockReturnValue(false)
  mocks.readFileSyncMock.mockReturnValue(Buffer.from(''))
  mocks.webContentsFromIdMock.mockReturnValue(mockWebContents(100))
}
