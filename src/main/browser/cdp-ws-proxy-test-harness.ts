import { vi, type Mock } from 'vitest'
import type { WebContents } from 'electron'
import WebSocket from 'ws'

type DebuggerListener = (...args: unknown[]) => void

type MockDebugger = {
  isAttached: Mock<() => boolean>
  attach: Mock<() => void>
  detach: Mock<() => void>
  sendCommand: Mock<
    (
      method?: string,
      params?: Record<string, unknown>,
      sessionId?: string
    ) => Promise<Record<string, unknown>>
  >
  on: Mock<(event: string, handler: DebuggerListener) => void>
  removeListener: Mock<(event: string, handler: DebuggerListener) => void>
}

// Explicit mock types avoid unnameable @vitest/spy Procedure types during declaration emit (TS2883).
export type MockWebContents = {
  webContents: {
    debugger: MockDebugger
    isDestroyed: () => boolean
    isCrashed: () => boolean
    focus: Mock<() => void>
    // Offscreen by default; use 'webview' for guest-direct input.
    getType: Mock<() => string>
    sendInputEvent: Mock<(event: Electron.KeyboardInputEvent) => void>
    setIgnoreMenuShortcuts: Mock<(ignore: boolean) => void>
    printToPDF: Mock<() => Promise<Buffer>>
    reload: Mock<() => void>
    reloadIgnoringCache: Mock<() => void>
    getTitle: Mock<() => string>
    getURL: Mock<() => string>
  }
  listeners: Map<string, DebuggerListener[]>
  destroy: () => void
  emit: (event: string, ...args: unknown[]) => void
}

export function createMockWebContents(): MockWebContents {
  const listeners = new Map<string, DebuggerListener[]>()
  let debuggerAttached = false
  let destroyed = false

  const debuggerObj = {
    isAttached: vi.fn(() => debuggerAttached),
    attach: vi.fn(() => {
      debuggerAttached = true
    }),
    detach: vi.fn(() => {
      debuggerAttached = false
    }),
    sendCommand: vi.fn(
      async (method?: string, _params?: Record<string, unknown>, _sessionId?: string) =>
        method === 'Page.captureScreenshot' ? { data: 'png' } : {}
    ),
    on: vi.fn((event: string, handler: DebuggerListener) => {
      const arr = listeners.get(event) ?? []
      arr.push(handler)
      listeners.set(event, arr)
    }),
    removeListener: vi.fn((event: string, handler: DebuggerListener) => {
      const arr = listeners.get(event) ?? []
      listeners.set(
        event,
        arr.filter((h) => h !== handler)
      )
    })
  }

  return {
    webContents: {
      debugger: debuggerObj,
      isDestroyed: () => destroyed,
      isCrashed: () => false,
      focus: vi.fn(),
      getType: vi.fn(() => 'window'),
      sendInputEvent: vi.fn(),
      setIgnoreMenuShortcuts: vi.fn(),
      printToPDF: vi.fn(async () => Buffer.from('%PDF-test')),
      reload: vi.fn(),
      reloadIgnoringCache: vi.fn(),
      getTitle: vi.fn(() => 'Example'),
      getURL: vi.fn(() => 'https://example.com')
    },
    listeners,
    destroy() {
      destroyed = true
    },
    emit(event: string, ...args: unknown[]) {
      for (const handler of listeners.get(event) ?? []) {
        handler(...args)
      }
    }
  }
}

export function mockAsWebContents(mock: MockWebContents, id?: number): WebContents {
  const contents = id === undefined ? mock.webContents : { ...mock.webContents, id }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mock implements every WebContents member the CDP proxy and page-input paths call.
  return contents as unknown as WebContents
}

export type SendCommandCall = [string, Record<string, unknown>?, string?]

export function connect(endpoint: string): Promise<WebSocket> {
  return new Promise((resolve) => {
    const ws = new WebSocket(endpoint)
    ws.on('open', () => resolve(ws))
  })
}

export function sendAndReceive(
  ws: WebSocket,
  msg: Record<string, unknown>
): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    ws.once('message', (data) => resolve(JSON.parse(data.toString())))
    ws.send(JSON.stringify(msg))
  })
}

const PAINT_PROBE_EXPRESSION =
  "[performance.getEntriesByType('paint').length > 0, performance.timeOrigin]"

// Hides the first-paint probe every embedded-guest input passes; its own test spies on holdPaint.
export function getSendCommandCalls(mock: MockWebContents): SendCommandCall[] {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mock records the (method, params, sessionId) it was called with.
  const calls = mock.webContents.debugger.sendCommand.mock.calls as unknown as SendCommandCall[]
  return calls.filter(
    ([method, params]) =>
      method !== 'Runtime.evaluate' || params?.expression !== PAINT_PROBE_EXPRESSION
  )
}

export function getSendCommandMethods(mock: MockWebContents): string[] {
  return getSendCommandCalls(mock).map((call) => call[0])
}
