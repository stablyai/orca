import { beforeEach, describe, expect, it, vi } from 'vitest'

const irohStart = vi.fn(async () => ({ endpointId: 'b'.repeat(64) }))
const irohConnect = vi.fn(async () => ({ connectionId: 'conn-1' }))
const irohSend = vi.fn(async () => {})
const irohClose = vi.fn(async () => {})
let messageListener: ((event: { connectionId: string; bytesBase64: string }) => void) | null = null
let closedListener: ((event: { connectionId: string; reason: string }) => void) | null = null

vi.mock('./expo-iroh-native-module', () => ({
  loadExpoIroh: () => ({
    irohStart,
    irohConnect,
    irohSend,
    irohClose,
    onIrohMessage: (listener: (event: { connectionId: string; bytesBase64: string }) => void) => {
      messageListener = listener
      return { remove: vi.fn() }
    },
    onIrohClosed: (listener: (event: { connectionId: string; reason: string }) => void) => {
      closedListener = listener
      return { remove: vi.fn() }
    },
    onIrohPathChanged: () => ({ remove: vi.fn() })
  }),
  expoIrohModuleLoads: () => true
}))

import { MobileIrohFramedSocket } from './mobile-iroh-framed-socket'

const endpointId = 'a'.repeat(64)

async function openSocket(): Promise<MobileIrohFramedSocket> {
  const socket = new MobileIrohFramedSocket({ desktopEndpointId: endpointId })
  await vi.waitFor(() => expect(socket.readyState).toBe(socket.OPEN))
  return socket
}

describe('MobileIrohFramedSocket', () => {
  beforeEach(() => {
    messageListener = null
    closedListener = null
    vi.clearAllMocks()
    irohStart.mockResolvedValue({ endpointId: 'b'.repeat(64) })
    irohConnect.mockResolvedValue({ connectionId: 'conn-1' })
  })

  it('dials with the pairing-supplied hints and opens', async () => {
    const socket = new MobileIrohFramedSocket({
      desktopEndpointId: endpointId,
      dialHints: { relayUrl: 'https://relay.example', directAddresses: ['192.168.1.9:41234'] }
    })
    const onopen = vi.fn()
    socket.onopen = onopen

    await vi.waitFor(() => expect(onopen).toHaveBeenCalled())
    expect(irohConnect).toHaveBeenCalledWith(endpointId, {
      relayUrl: 'https://relay.example',
      directAddresses: ['192.168.1.9:41234']
    })
    expect(socket.readyState).toBe(socket.OPEN)
  })

  it('decodes ASCII payloads as text and high-byte payloads as bytes', async () => {
    const socket = await openSocket()
    const received: (string | Uint8Array)[] = []
    socket.onmessage = (event) => received.push(event.data)

    messageListener?.({ connectionId: 'conn-1', bytesBase64: btoa('{"type":"e2ee_hello"}') })
    messageListener?.({
      connectionId: 'conn-1',
      bytesBase64: btoa(String.fromCharCode(0x00, 0xff, 0x7f))
    })

    expect(received[0]).toBe('{"type":"e2ee_hello"}')
    expect(received[1]).toBeInstanceOf(Uint8Array)
  })

  it('ignores events addressed to another connection', async () => {
    const socket = await openSocket()
    const onmessage = vi.fn()
    const onclose = vi.fn()
    socket.onmessage = onmessage
    socket.onclose = onclose

    messageListener?.({ connectionId: 'other', bytesBase64: btoa('x') })
    closedListener?.({ connectionId: 'other', reason: 'unrelated' })

    expect(onmessage).not.toHaveBeenCalled()
    expect(onclose).not.toHaveBeenCalled()
  })

  it('forwards the requested close code and stays quiet on onerror', async () => {
    const socket = await openSocket()
    const onclose = vi.fn()
    const onerror = vi.fn()
    socket.onclose = onclose
    socket.onerror = onerror

    socket.close(1001, 'going_away')

    expect(onclose).toHaveBeenCalledWith({ code: 1001, reason: 'going_away' })
    expect(onerror).not.toHaveBeenCalled()
    expect(irohClose).toHaveBeenCalledWith('conn-1')
    expect(socket.readyState).toBe(socket.CLOSED)
  })

  it('defaults a bare close() to a clean 1000', async () => {
    const socket = await openSocket()
    const onclose = vi.fn()
    const onerror = vi.fn()
    socket.onclose = onclose
    socket.onerror = onerror

    socket.close()

    expect(onclose).toHaveBeenCalledWith({ code: 1000, reason: 'client_close' })
    expect(onerror).not.toHaveBeenCalled()
  })

  it('surfaces a desktop auth close as 4001 so rpc-client can latch re-pair', async () => {
    const socket = await openSocket()
    const onclose = vi.fn()
    const onerror = vi.fn()
    socket.onclose = onclose
    socket.onerror = onerror

    closedListener?.({ connectionId: 'conn-1', reason: 'closed by peer: 4001: unauthorized' })

    expect(onclose).toHaveBeenCalledWith({
      code: 4001,
      reason: 'closed by peer: 4001: unauthorized'
    })
    expect(onerror).toHaveBeenCalled()
  })

  it('treats a non-auth remote close as a drop, not an auth failure', async () => {
    const socket = await openSocket()
    const onclose = vi.fn()
    socket.onclose = onclose

    closedListener?.({ connectionId: 'conn-1', reason: 'timed out' })

    expect(onclose).toHaveBeenCalledWith({ code: 1000, reason: 'timed out' })
  })

  it('fails the socket when the dial rejects', async () => {
    irohConnect.mockRejectedValueOnce(new Error('no route'))
    const socket = new MobileIrohFramedSocket({ desktopEndpointId: endpointId })
    const onclose = vi.fn()
    const onerror = vi.fn()
    socket.onclose = onclose
    socket.onerror = onerror

    await vi.waitFor(() => expect(onclose).toHaveBeenCalled())
    expect(onclose).toHaveBeenCalledWith({ code: 1006, reason: 'no route' })
    expect(onerror).toHaveBeenCalled()
    expect(socket.readyState).toBe(socket.CLOSED)
  })

  it('closes a connection that arrived after the caller gave up', async () => {
    let resolveConnect: ((value: { connectionId: string }) => void) | null = null
    irohConnect.mockImplementationOnce(
      () =>
        new Promise<{ connectionId: string }>((resolve) => {
          resolveConnect = resolve
        })
    )
    const socket = new MobileIrohFramedSocket({ desktopEndpointId: endpointId })
    await vi.waitFor(() => expect(resolveConnect).not.toBeNull())

    socket.close()
    resolveConnect!({ connectionId: 'late-conn' })

    await vi.waitFor(() => expect(irohClose).toHaveBeenCalledWith('late-conn'))
  })

  it('base64-encodes sends and drops them once closed', async () => {
    const socket = await openSocket()

    socket.send('hello')
    expect(irohSend).toHaveBeenCalledWith('conn-1', btoa('hello'))

    socket.close()
    irohSend.mockClear()
    socket.send('after-close')
    expect(irohSend).not.toHaveBeenCalled()
  })

  it('round-trips a payload larger than one base64 chunk', async () => {
    const socket = await openSocket()
    const big = new Uint8Array(0x8000 + 17).fill(0x41)

    socket.send(big)

    const [, b64] = irohSend.mock.calls[0] as unknown as [string, string]
    expect(atob(b64)).toHaveLength(big.byteLength)
  })
})
