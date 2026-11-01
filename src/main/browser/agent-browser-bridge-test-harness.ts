import { EventEmitter } from 'node:events'
import { vi, type Mock } from 'vitest'
import type { AgentBrowserBridge } from './agent-browser-bridge'
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
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Bridge tests supply only the BrowserManager methods they exercise.
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
    getPopupPages: () => [],
    getGuestWebContentsId: vi.fn(() => null),
    getSessionProfileIdForTab: vi.fn(() => null),
    getBrowserPageLoadError: vi.fn(() => null),
    getBrowserPageCertificateFailure: vi.fn(() => null),
    unregisterGuest: vi.fn(),
    holdPaintForCapture: () => () => {},
    holdGuestActive: () => () => {},
    beginAgentCommand: () => ({
      agent: false,
      run: (execute: () => Promise<unknown>) => execute(),
      end: () => {}
    }),
    showAgentPointer: async () => {},
    isAgentUsingPage: () => false,
    handOverAgentActivity: () => {},
    ...overrides
  } as unknown as BrowserManager
}

type MockEmitterListener = (...args: any[]) => void

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
  isCrashed: () => boolean
  invalidate: Mock<() => void>
  focus: Mock<() => void>
  // Offscreen by default; use 'webview' for guest-direct key input.
  getType: Mock<() => string>
  sendInputEvent: Mock<(event: Electron.KeyboardInputEvent) => void>
  setIgnoreMenuShortcuts: Mock<(ignore: boolean) => void>
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
    isCrashed: () => false,
    invalidate: vi.fn(),
    focus: vi.fn(),
    getType: vi.fn(() => 'window'),
    sendInputEvent: vi.fn(),
    setIgnoreMenuShortcuts: vi.fn(),
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

// Dynamic require('electron') bypasses the module mock; override the protected lookup.
export function overrideBridgeWebContentsLookup(
  bridgePrototype: AgentBrowserBridge,
  webContentsFromIdMock: Mock
): void {
  Object.defineProperty(bridgePrototype, 'getWebContents', {
    configurable: true,
    enumerable: true,
    writable: true,
    value: function (id: number) {
      const target = webContentsFromIdMock(id) as { isDestroyed: () => boolean } | null
      return target && !target.isDestroyed() ? target : null
    }
  })
}

// Raw-process execution subscribes to the child's exit event.
export function createFakeAgentBrowserChild<T extends object>(fields: T): EventEmitter & T {
  return Object.assign(new EventEmitter(), fields)
}

/** The agent-browser command a spawn ran: batch commands arrive on stdin, raw CLI tokens in argv. */
export function agentBrowserCommandOf(args: readonly string[], stdin?: string): string[] {
  if (stdin !== undefined && args.includes('batch')) {
    const [command]: string[][] = JSON.parse(stdin)
    return command
  }
  let start = 0
  while (args[start]?.startsWith('--')) {
    start += 2
  }
  return args.slice(start).filter((arg) => arg !== '--json')
}

export function agentBrowserCommandsIn(stdinWrites: readonly string[]): string[][] {
  return stdinWrites.map((stdin) => JSON.parse(stdin)[0])
}

type FakeAgentBrowserChild = EventEmitter & { kill: Mock }

/** Answers each spawn once its command is known, which for batch is when stdin ends. */
export function answerAgentBrowserCommands(
  execFileMock: Mock,
  stdinWrites: string[],
  answer: (
    command: string[],
    cb: ExecFileCallback,
    args: string[],
    child: FakeAgentBrowserChild
  ) => void
): void {
  execFileMock.mockImplementation(
    (_bin: string, args: string[], _opts: unknown, cb: ExecFileCallback) => {
      const child = createFakeAgentBrowserChild({
        kill: vi.fn(),
        stdin: {
          on: vi.fn(),
          end: (text?: string) => {
            if (text !== undefined) {
              stdinWrites.push(text)
            } else if (!args.includes('batch')) {
              // Commands outside a batch were answered from argv at spawn.
              return
            }
            answer(agentBrowserCommandOf(args, text), cb, args, child)
          }
        }
      })
      if (!args.includes('batch')) {
        answer(agentBrowserCommandOf(args), cb, args, child)
      }
      return child
    }
  )
}

export type AgentBrowserSpawn = { command: string[]; args: string[] }

/** Succeeds every spawn with `data` and records each command beside its argv. */
export function succeedRecordingAgentBrowserSpawns(
  execFileMock: Mock,
  stdinWrites: string[],
  data: unknown
): AgentBrowserSpawn[] {
  const spawns: AgentBrowserSpawn[] = []
  answerAgentBrowserCommands(execFileMock, stdinWrites, (command, cb, args) => {
    spawns.push({ command, args })
    cb(null, JSON.stringify({ success: true, data }), '')
  })
  return spawns
}

export function createSucceedWith(execFileMock: Mock, stdinWrites: string[]) {
  return function succeedWith(data: unknown): void {
    execFileMock.mockImplementation(
      (_bin: string, _args: string[], _opts: unknown, cb: ExecFileCallback) => {
        cb(null, JSON.stringify({ success: true, data }), '')
        return createFakeAgentBrowserChild({
          stdin: { on: vi.fn(), end: (text: string) => stdinWrites.push(text) }
        })
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
