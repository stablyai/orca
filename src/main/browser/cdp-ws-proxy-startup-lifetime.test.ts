import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CdpWsProxy } from './cdp-ws-proxy'
import { acquireElectronDebugger } from './electron-debugger-lease'
import { createMockWebContents, mockAsWebContents } from './cdp-ws-proxy-test-harness'

const { createServerMock, webSocketServerMock } = vi.hoisted(() => ({
  createServerMock: vi.fn(),
  webSocketServerMock: vi.fn()
}))

vi.mock('electron', () => ({ webContents: { fromId: vi.fn() } }))
vi.mock('node:http', () => ({ createServer: createServerMock }))
vi.mock('ws', () => ({
  default: { OPEN: 1 },
  WebSocket: { OPEN: 1 },
  WebSocketServer: webSocketServerMock
}))

class ProxyServer extends EventEmitter {
  listening = false

  listen(_port: number, _host: string, callback: () => void): void {
    this.listening = true
    queueMicrotask(callback)
  }

  address(): { port: number } {
    return { port: 9222 }
  }

  close(): void {
    this.listening = false
  }
}

class ProxyWebSocketServer extends EventEmitter {
  closed = false

  close(): void {
    this.closed = true
  }
}

function pendingEnable(mock: ReturnType<typeof createMockWebContents>) {
  let finish = (): void => {}
  let fail = (_error: Error): void => {}
  const command = new Promise<Record<string, unknown>>((resolve, reject) => {
    finish = () => resolve({})
    fail = reject
  })
  mock.webContents.debugger.sendCommand.mockReturnValueOnce(command)
  return { finish, fail }
}

function invalidateNativeHandle(mock: ReturnType<typeof createMockWebContents>): void {
  mock.destroy()
  Object.defineProperty(mock.webContents, 'debugger', {
    get() {
      throw new Error('Object has been destroyed')
    }
  })
}

describe('CdpWsProxy startup ownership', () => {
  let servers: ProxyServer[]
  let socketServers: ProxyWebSocketServer[]
  let proxies: CdpWsProxy[]

  beforeEach(() => {
    servers = []
    socketServers = []
    proxies = []
    createServerMock.mockImplementation(() => {
      const server = new ProxyServer()
      servers.push(server)
      return server
    })
    webSocketServerMock.mockImplementation(function () {
      const server = new ProxyWebSocketServer()
      socketServers.push(server)
      return server
    })
  })

  afterEach(async () => {
    await Promise.all(proxies.map((proxy) => proxy.stop()))
    expect(servers.filter((server) => server.listening)).toHaveLength(0)
    expect(socketServers.filter((server) => !server.closed)).toHaveLength(0)
  })

  function makeProxy(mock: ReturnType<typeof createMockWebContents>): CdpWsProxy {
    const proxy = new CdpWsProxy(mockAsWebContents(mock), () => () => {})
    proxies.push(proxy)
    return proxy
  }

  function expectNoListeners(mock: ReturnType<typeof createMockWebContents>): void {
    expect(mock.listeners.get('message') ?? []).toHaveLength(0)
    expect(mock.listeners.get('detach') ?? []).toHaveLength(0)
  }

  it('tolerates Page.enable rejection on a live shared attachment', async () => {
    const mock = createMockWebContents()
    const debuggerHandle = mock.webContents.debugger
    const lease = acquireElectronDebugger(mockAsWebContents(mock))
    debuggerHandle.sendCommand.mockRejectedValueOnce(new Error('Page domain is not ready'))
    const proxy = makeProxy(mock)

    await expect(proxy.start()).resolves.toBe('ws://127.0.0.1:9222')
    await proxy.stop()

    expectNoListeners(mock)
    expect(debuggerHandle.isAttached()).toBe(true)
    expect(debuggerHandle.detach).not.toHaveBeenCalled()
    lease.release()
    expect(debuggerHandle.attach).toHaveBeenCalledTimes(1)
    expect(debuggerHandle.detach).toHaveBeenCalledTimes(1)
  })

  it.each([false, true])(
    'refuses server admission after native detach during Page.enable (destroyed: %s)',
    async (destroyed) => {
      const mock = createMockWebContents()
      const debuggerHandle = mock.webContents.debugger
      const enable = pendingEnable(mock)
      const proxy = makeProxy(mock)
      const starting = proxy.start()
      debuggerHandle.isAttached.mockReturnValue(false)
      if (destroyed) {
        invalidateNativeHandle(mock)
      }
      mock.emit('detach', {}, 'target closed')
      enable.fail(new Error('target closed while handling command'))

      await expect(starting).rejects.toThrow('detached during startup')
      expect(proxy.getPort()).toBe(0)
      expect(servers).toHaveLength(0)
      expect(socketServers).toHaveLength(0)
      expectNoListeners(mock)
    }
  )

  it('cleans a destroyed startup even when no native detach event arrives', async () => {
    const mock = createMockWebContents()
    const enable = pendingEnable(mock)
    const proxy = makeProxy(mock)
    const starting = proxy.start()
    invalidateNativeHandle(mock)
    enable.fail(new Error('target closed while handling command'))

    await expect(starting).rejects.toThrow('no longer available')
    expect(servers).toHaveLength(0)
    expectNoListeners(mock)
  })

  it('refuses server admission when stopped after attachment completes', async () => {
    const mock = createMockWebContents()
    const proxy = makeProxy(mock)
    const starting = proxy.start()
    await Promise.resolve()
    await proxy.stop()

    await expect(starting).rejects.toThrow('stopped')
    expect(servers).toHaveLength(0)
    expectNoListeners(mock)
  })

  it('does not detach a successor when stopped Page.enable completes late', async () => {
    const mock = createMockWebContents()
    const debuggerHandle = mock.webContents.debugger
    const enable = pendingEnable(mock)
    const proxy = makeProxy(mock)
    const starting = proxy.start()
    await proxy.stop()
    const successor = makeProxy(mock)
    await successor.start()
    enable.finish()

    await expect(starting).rejects.toThrow('detached during startup')
    expect(servers).toHaveLength(1)
    expect(debuggerHandle.isAttached()).toBe(true)
    expect(debuggerHandle.detach).toHaveBeenCalledTimes(1)
    expect(mock.listeners.get('message')).toHaveLength(1)
    expect(mock.listeners.get('detach')).toHaveLength(1)
    await successor.stop()
    expect(debuggerHandle.detach).toHaveBeenCalledTimes(2)
    expectNoListeners(mock)
  })

  it('retires an established proxy without reading a destroyed native handle', async () => {
    const mock = createMockWebContents()
    const proxy = makeProxy(mock)
    await proxy.start()
    invalidateNativeHandle(mock)

    await expect(proxy.stop()).resolves.toBeUndefined()
    expectNoListeners(mock)
    expect(servers[0].listening).toBe(false)
    expect(socketServers[0].closed).toBe(true)
  })

  it('closes server resources even if debugger cleanup throws', async () => {
    const mock = createMockWebContents()
    const proxy = makeProxy(mock)
    await proxy.start()
    mock.webContents.debugger.removeListener.mockImplementationOnce(() => {
      throw new Error('debugger cleanup failed')
    })

    await expect(proxy.stop()).rejects.toThrow('debugger cleanup failed')
    expect(servers[0].listening).toBe(false)
    expect(socketServers[0].closed).toBe(true)
    expect(mock.webContents.debugger.detach).toHaveBeenCalledTimes(1)
  })
})
