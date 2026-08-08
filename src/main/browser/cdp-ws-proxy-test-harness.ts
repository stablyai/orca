import { vi, type Mock } from 'vitest'
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

// Why: annotate the return explicitly so the exported inferred type stays nameable under
// composite declaration emit — otherwise the vi.fn() mocks leak @vitest/spy's Procedure
// and tsgo reports TS2883.
export type AgentInputDetail = {
  phase: 'begin' | 'end'
  guestId: number
  borrowId: number
}

export type MockWebContents = {
  webContents: {
    debugger: MockDebugger
    isDestroyed: () => boolean
    id: number
    focus: Mock<() => void>
    hostWebContents: {
      isDestroyed: Mock<() => boolean>
      send: Mock<(channel: string, detail: AgentInputDetail) => void>
    }
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

export function createMockWebContents(options?: {
  /** Stands in for the host renderer answering a focus borrow. */
  onAgentInput?: (detail: AgentInputDetail) => void
}): MockWebContents {
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
      async (_method?: string, _params?: Record<string, unknown>, _sessionId?: string) => ({})
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
      id: 1,
      focus: vi.fn(),
      // Why: the proxy lends DOM focus to the guest by messaging its host renderer.
      hostWebContents: {
        isDestroyed: vi.fn(() => false),
        send: vi.fn((_channel: string, detail: AgentInputDetail) => {
          options?.onAgentInput?.(detail)
        })
      },
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

export function getSendCommandCalls(mock: MockWebContents): SendCommandCall[] {
  return mock.webContents.debugger.sendCommand.mock.calls as unknown as SendCommandCall[]
}

export function getSendCommandMethods(mock: MockWebContents): string[] {
  return getSendCommandCalls(mock).map((call) => call[0])
}
