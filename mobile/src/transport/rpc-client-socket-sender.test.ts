import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { RpcClientSocketSender } from './rpc-client-socket-sender'
import { decryptBytes } from './e2ee'

vi.mock('expo-crypto', () => ({
  getRandomBytes: (length: number) => new Uint8Array(length).fill(7)
}))
class TestSocket {
  static OPEN = 1
  readyState = 1
  bufferedAmount = 9 * 1024 * 1024
  sent: Uint8Array[] = []
  send(bytes: Uint8Array) {
    this.sent.push(bytes)
  }
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('WebSocket', TestSocket)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function setup(claimQueuedBytes?: (bytes: number) => (() => void) | null) {
  const socket = new TestSocket()
  const key = new Uint8Array(32).fill(3)
  const forceClose = vi.fn()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the sender reads only readyState, bufferedAmount and send from this socket double.
  const webSocket = socket as unknown as WebSocket
  const sender = new RpcClientSocketSender({
    socket: webSocket,
    claimQueuedBytes,
    getKey: () => key,
    getCurrentSocket: () => webSocket,
    getState: () => 'connected',
    isAuthenticated: () => true,
    forceClose
  })
  return { sender, socket, key, forceClose }
}

it('retains an immutable binary copy until the shared queue drains, then encrypts it', () => {
  const { sender, socket, key } = setup()
  const bytes = new Uint8Array([1, 2, 3])
  expect(sender.sendBinary(bytes)).toBe(true)
  bytes.fill(9)
  expect(socket.sent).toEqual([])
  socket.bufferedAmount = 0
  vi.advanceTimersByTime(25)
  expect(socket.sent).toHaveLength(1)
  expect(decryptBytes(socket.sent[0]!, key)).toEqual(new Uint8Array([1, 2, 3]))
  sender.dispose()
  expect(vi.getTimerCount()).toBe(0)
})

it('rejects the overflowing frame and disposes queued bytes on close', () => {
  const { sender, socket, forceClose } = setup()
  for (let i = 0; i < 4096; i++) {
    expect(sender.sendBinary(new Uint8Array([i & 255]))).toBe(true)
  }
  expect(sender.sendBinary(new Uint8Array([1]))).toBe(false)
  expect(forceClose).toHaveBeenCalledOnce()
  sender.dispose()
  socket.bufferedAmount = 0
  vi.runAllTimers()
  expect(socket.sent).toEqual([])
  expect(sender.sendBinary(new Uint8Array([1]))).toBe(false)
  expect(vi.getTimerCount()).toBe(0)
})

it('charges the route budget for retained frames and releases it on cancellation', () => {
  const release = vi.fn()
  const claim = vi.fn().mockReturnValueOnce(release).mockReturnValue(null)
  const { sender, forceClose } = setup(claim)
  expect(sender.sendBinary(new Uint8Array([1]))).toBe(true)
  expect(claim).toHaveBeenCalledWith(41)
  expect(sender.sendBinary(new Uint8Array([2]))).toBe(false)
  expect(release).toHaveBeenCalledOnce()
  expect(forceClose).toHaveBeenCalledOnce()
  sender.dispose()
  expect(release).toHaveBeenCalledOnce()
})
