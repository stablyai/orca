import { describe, expect, it, vi } from 'vitest'
import type { IncomingMessage } from 'node:http'
import { CdpWsProxy } from './cdp-ws-proxy'

type VerifyClient = (
  info: { req: IncomingMessage },
  done: (result: boolean, code?: number, message?: string) => void
) => void

const { admissionMock, httpServer, websocketServerState } = vi.hoisted(() => ({
  admissionMock: vi.fn(),
  httpServer: {
    address: vi.fn(() => ({ port: 43_127 })),
    close: vi.fn(),
    listen: vi.fn((_port: number, _host: string, listening: () => void) => listening()),
    once: vi.fn(),
    removeListener: vi.fn()
  },
  websocketServerState: {
    options: undefined as { server?: unknown; verifyClient?: VerifyClient } | undefined
  }
}))

vi.mock('node:http', () => ({
  createServer: vi.fn(() => httpServer)
}))

vi.mock('ws', () => {
  class WebSocketServer {
    constructor(options: { server?: unknown; verifyClient?: VerifyClient }) {
      websocketServerState.options = options
    }

    close(): void {}
    on(): void {}
  }

  class WebSocket {
    static readonly OPEN = 1
  }

  return { WebSocket, WebSocketServer }
})

vi.mock('./cdp-ws-proxy-access-guard', () => ({
  isAllowedCdpProxyRequest: admissionMock
}))

function webContents(): never {
  return {
    debugger: {
      attach: vi.fn(),
      detach: vi.fn(),
      isAttached: vi.fn(() => false),
      on: vi.fn(),
      removeListener: vi.fn(),
      sendCommand: vi.fn(async () => ({}))
    },
    isDestroyed: vi.fn(() => false)
  } as never
}

describe('CdpWsProxy WebSocket admission', () => {
  it('wires the shared request guard into WebSocketServer verifyClient', async () => {
    const proxy = new CdpWsProxy(webContents())
    await proxy.start()
    const options = websocketServerState.options

    expect(options?.server).toBe(httpServer)
    expect(options?.verifyClient).toEqual(expect.any(Function))

    const request = {} as IncomingMessage
    const denied = vi.fn()
    admissionMock.mockReturnValueOnce(false)
    options!.verifyClient!({ req: request }, denied)

    expect(admissionMock).toHaveBeenLastCalledWith(request, 43_127)
    expect(denied).toHaveBeenCalledWith(false, 403, 'Forbidden')

    const allowed = vi.fn()
    admissionMock.mockReturnValueOnce(true)
    options!.verifyClient!({ req: request }, allowed)

    expect(allowed).toHaveBeenCalledWith(true)
    await proxy.stop()
  })
})
