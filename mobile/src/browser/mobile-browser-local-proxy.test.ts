import { describe, expect, it, vi } from 'vitest'
import type {
  OrcaProxiedBrowserModule,
  ProxiedBrowserProxyEvents
} from '../../modules/orca-proxied-browser/src'
import type {
  MobileBrowserTunnelStream,
  MobileBrowserTunnelStreamSink
} from './mobile-browser-tunnel-client'
import { bridgeProxiedBrowserToTunnel, proxiedBrowserStoreId } from './mobile-browser-local-proxy'

function nativeModule() {
  const listeners: Partial<ProxiedBrowserProxyEvents> = {}
  const module = {
    isSupported: () => true,
    startProxy: vi.fn(async () => 4000),
    stopProxy: vi.fn(async () => {}),
    proxyAccept: vi.fn(),
    proxyReject: vi.fn(),
    proxyWrite: vi.fn(),
    proxyEnd: vi.fn(),
    proxyClose: vi.fn(),
    addListener: <E extends keyof ProxiedBrowserProxyEvents>(
      event: E,
      listener: ProxiedBrowserProxyEvents[E]
    ) => {
      listeners[event] = listener
      return { remove: () => delete listeners[event] }
    }
  } satisfies OrcaProxiedBrowserModule
  const fire = {
    onProxyOpen: (event: Parameters<ProxiedBrowserProxyEvents['onProxyOpen']>[0]) =>
      listeners.onProxyOpen?.(event),
    onProxyData: (event: Parameters<ProxiedBrowserProxyEvents['onProxyData']>[0]) =>
      listeners.onProxyData?.(event),
    onProxyEnd: (event: Parameters<ProxiedBrowserProxyEvents['onProxyEnd']>[0]) =>
      listeners.onProxyEnd?.(event),
    onProxyClosed: (event: Parameters<ProxiedBrowserProxyEvents['onProxyClosed']>[0]) =>
      listeners.onProxyClosed?.(event)
  }
  return { module, fire, listeners }
}

function tunnel() {
  const sinks: MobileBrowserTunnelStreamSink[] = []
  const stream: MobileBrowserTunnelStream = { write: vi.fn(), end: vi.fn(), close: vi.fn() }
  const open = vi.fn(
    (_target: { host: string; port: number }, sink: MobileBrowserTunnelStreamSink) => {
      sinks.push(sink)
      return stream
    }
  )
  return { open, stream, sinks }
}

describe('bridgeProxiedBrowserToTunnel', () => {
  it('opens a tunnel stream for each proxy connection of its host and accepts when the host connects', () => {
    const native = nativeModule()
    const host = tunnel()
    bridgeProxiedBrowserToTunnel(native.module, 'host-a', host)

    native.fire.onProxyOpen({ proxy: 'host-b', connection: 1, host: 'other.test', port: 443 })
    expect(host.open).not.toHaveBeenCalled()

    native.fire.onProxyOpen({ proxy: 'host-a', connection: 2, host: 'example.test', port: 443 })
    expect(host.open).toHaveBeenCalledWith({ host: 'example.test', port: 443 }, expect.anything())
    host.sinks[0]!.opened()
    expect(native.module.proxyAccept).toHaveBeenCalledWith(2)
  })

  it('moves bytes both ways and forwards half-closes', () => {
    const native = nativeModule()
    const host = tunnel()
    bridgeProxiedBrowserToTunnel(native.module, 'host-a', host)
    native.fire.onProxyOpen({ proxy: 'host-a', connection: 2, host: 'example.test', port: 80 })
    host.sinks[0]!.opened()

    native.fire.onProxyData({ connection: 2, data: btoa('GET /') })
    expect(host.stream.write).toHaveBeenCalledWith(new TextEncoder().encode('GET /'))
    host.sinks[0]!.data(new Uint8Array([1, 2]))
    expect(native.module.proxyWrite).toHaveBeenCalledWith(2, new Uint8Array([1, 2]))

    native.fire.onProxyEnd({ connection: 2 })
    expect(host.stream.end).toHaveBeenCalledOnce()
    host.sinks[0]!.end()
    expect(native.module.proxyEnd).toHaveBeenCalledWith(2)
  })

  it('rejects a connection the host could not open, and closes one it ended', () => {
    const native = nativeModule()
    const host = tunnel()
    bridgeProxiedBrowserToTunnel(native.module, 'host-a', host)
    native.fire.onProxyOpen({ proxy: 'host-a', connection: 2, host: 'example.test', port: 22 })
    host.sinks[0]!.closed('destination_connect_failed')
    expect(native.module.proxyReject).toHaveBeenCalledWith(2)

    native.fire.onProxyOpen({ proxy: 'host-a', connection: 3, host: 'example.test', port: 80 })
    host.sinks[1]!.opened()
    host.sinks[1]!.closed()
    expect(native.module.proxyClose).toHaveBeenCalledWith(3)
  })

  it('closes the tunnel stream when the web view drops the connection', () => {
    const native = nativeModule()
    const host = tunnel()
    bridgeProxiedBrowserToTunnel(native.module, 'host-a', host)
    native.fire.onProxyOpen({ proxy: 'host-a', connection: 2, host: 'example.test', port: 80 })
    native.fire.onProxyClosed({ connection: 2 })
    expect(host.stream.close).toHaveBeenCalledOnce()
  })

  it('stops listening and closes its streams when stopped', () => {
    const native = nativeModule()
    const host = tunnel()
    const bridge = bridgeProxiedBrowserToTunnel(native.module, 'host-a', host)
    native.fire.onProxyOpen({ proxy: 'host-a', connection: 2, host: 'example.test', port: 80 })
    bridge.stop()
    expect(host.stream.close).toHaveBeenCalledOnce()
    expect(Object.keys(native.listeners)).toEqual([])
  })
})

describe('proxiedBrowserStoreId', () => {
  it('names one stable cookie jar per host', () => {
    const first = proxiedBrowserStoreId('host-a')
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(proxiedBrowserStoreId('host-a')).toBe(first)
    expect(proxiedBrowserStoreId('host-b')).not.toBe(first)
  })
})

describe('a stream the tunnel closes while opening it', () => {
  it('rejects the proxy connection and forgets it', () => {
    const native = nativeModule()
    const stream: MobileBrowserTunnelStream = { write: vi.fn(), end: vi.fn(), close: vi.fn() }
    bridgeProxiedBrowserToTunnel(native.module, 'host-a', {
      open: (_target, sink) => {
        sink.closed('tunnel_closed')
        return stream
      }
    })
    native.fire.onProxyOpen({ proxy: 'host-a', connection: 7, host: 'example.com', port: 443 })
    expect(native.module.proxyReject).toHaveBeenCalledWith(7)
    native.fire.onProxyData({ connection: 7, data: 'AA==' })
    expect(stream.write).not.toHaveBeenCalled()
  })
})
