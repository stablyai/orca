import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { connect } from './rpc-client'
import { ConnectionRouteError, type ConnectionRouteLease } from './connection-route'
import { isRpcDeliveryUnknown } from './rpc-delivery-ambiguity'

vi.mock('./e2ee', () => ({
  generateKeyPair: () => ({ publicKey: new Uint8Array(32), secretKey: new Uint8Array(32) }),
  deriveSharedKey: () => new Uint8Array(32),
  publicKeyFromBase64: () => new Uint8Array(32),
  publicKeyToBase64: () => 'client-key',
  encrypt: (value: string) => value,
  decrypt: (value: string) => value
}))
vi.mock('./mobile-runtime-capability-negotiation', () => ({
  negotiateMobileRuntimeCapabilities: (args: { onReady(): void }) => args.onReady()
}))

class Socket {
  static OPEN = 1
  static CLOSED = 3
  static CONNECTING = 0
  readyState = 0
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  sent: string[] = []
  constructor(readonly endpoint: string) {
    sockets.push(this)
  }
  send(value: string) {
    this.sent.push(value)
  }
  close() {
    this.readyState = 3
    this.onclose?.()
  }
  authenticate() {
    this.readyState = 1
    this.onopen?.()
    this.onmessage?.({ data: JSON.stringify({ type: 'e2ee_ready' }) })
    this.onmessage?.({ data: JSON.stringify({ type: 'e2ee_authenticated' }) })
  }
}
const sockets: Socket[] = []
beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('WebSocket', Socket)
  sockets.length = 0
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it('routes every reconnect through a fresh lease and retains RPC delivery-unknown semantics', async () => {
  const closeFirst = vi.fn()
  const closeSecond = vi.fn()
  const open = vi
    .fn()
    .mockResolvedValueOnce({ endpoint: 'ws://127.0.0.1:1234', close: closeFirst })
    .mockResolvedValueOnce({ endpoint: 'ws://127.0.0.1:2345', close: closeSecond })
  const client = connect('ws://unreachable:6768', 'token', 'key', { routeProvider: { open } })
  expect(sockets).toHaveLength(0)
  await vi.advanceTimersByTimeAsync(0)
  expect(sockets[0]?.endpoint).toBe('ws://127.0.0.1:1234')
  sockets[0]!.authenticate()
  const pending = client
    .sendRequest('terminal.send', { terminal: 't' })
    .catch((error: unknown) => error)
  await vi.advanceTimersByTimeAsync(0)
  sockets[0]!.close()
  expect(isRpcDeliveryUnknown(await pending)).toBe(true)
  expect(closeFirst).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(500)
  expect(sockets[1]?.endpoint).toBe('ws://127.0.0.1:2345')
  client.close()
  expect(closeSecond).toHaveBeenCalledOnce()
})

it('never opens a socket when a tunnel completes after client close', async () => {
  const pending = Promise.withResolvers<ConnectionRouteLease>()
  const client = connect('ws://server:6768', 'token', 'key', {
    routeProvider: { open: () => pending.promise }
  })
  await vi.advanceTimersByTimeAsync(0)
  const request = client.sendRequest('status.get').catch((error: unknown) => error)
  client.close()
  const close = vi.fn()
  pending.resolve({ endpoint: 'ws://127.0.0.1:1234', close })
  await vi.advanceTimersByTimeAsync(0)
  expect(await request).toBeInstanceOf(Error)
  expect(sockets).toHaveLength(0)
  expect(close).toHaveBeenCalledOnce()
})

it('latches a host-key refusal without retrying or exposing the server directly', async () => {
  const open = vi.fn().mockRejectedValue(new ConnectionRouteError('SSH host key changed.', false))
  const client = connect('ws://server:6768', 'token', 'key', { routeProvider: { open } })
  await vi.advanceTimersByTimeAsync(120_000)
  expect(client.getState()).toBe('auth-failed')
  expect(open).toHaveBeenCalledOnce()
  expect(sockets).toHaveLength(0)
  client.close()
})

it('retries a failed route using the existing backoff', async () => {
  const close = vi.fn()
  const open = vi
    .fn()
    .mockRejectedValueOnce(new ConnectionRouteError('offline', true))
    .mockResolvedValueOnce({ endpoint: 'ws://127.0.0.1:1234', close })
  const client = connect('ws://server:6768', 'token', 'key', { routeProvider: { open } })
  await vi.advanceTimersByTimeAsync(0)
  expect(client.getState()).toBe('reconnecting')
  await vi.advanceTimersByTimeAsync(500)
  expect(open).toHaveBeenCalledTimes(2)
  expect(sockets[0]?.endpoint).toBe('ws://127.0.0.1:1234')
  client.close()
})
