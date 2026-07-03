import { vi } from 'vitest'
import WebSocket from 'ws'

type DebuggerListener = (...args: unknown[]) => void

export function createMockWebContents() {
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
      focus: vi.fn(),
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

export type MockWebContents = ReturnType<typeof createMockWebContents>
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
