import AsyncStorage from '@react-native-async-storage/async-storage'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { saveIrohHomeRelayUrl } from '../storage/preferences'

const stored = vi.hoisted(() => new Map<string, string>())
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => stored.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      stored.set(key, value)
    }),
    removeItem: vi.fn(async (key: string) => {
      stored.delete(key)
    })
  }
}))

const irohStart = vi.fn(async (_homeRelayUrl: string | null) => ({ endpointId: 'b'.repeat(64) }))
const irohConnect = vi.fn(
  async (
    _endpointId: string,
    _hints?: { relayUrl?: string | null; directAddresses?: string[] }
  ) => ({ connectionId: 'conn-1' })
)
const irohSend = vi.fn(async (_connectionId: string, _b64: string) => {})
const irohClose = vi.fn(async () => {})
const irohStop = vi.fn(async () => {})
let messageListener: ((event: { connectionId: string; bytesBase64: string }) => void) | null = null
let closedListener: ((event: { connectionId: string; reason: string }) => void) | null = null

vi.mock('./expo-iroh-native-module', () => ({
  loadExpoIroh: () => ({
    irohStart,
    irohConnect,
    irohSend,
    irohClose,
    irohStop,
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

import {
  MobileIrohFramedSocket,
  type MobileIrohFramedSocketOptions
} from './mobile-iroh-framed-socket'

const endpointId = 'a'.repeat(64)
const sockets: MobileIrohFramedSocket[] = []

function createSocket(
  options: MobileIrohFramedSocketOptions = { desktopEndpointId: endpointId }
): MobileIrohFramedSocket {
  const socket = new MobileIrohFramedSocket(options)
  sockets.push(socket)
  return socket
}

async function openSocket(): Promise<MobileIrohFramedSocket> {
  const socket = createSocket()
  await vi.waitFor(() => expect(socket.readyState).toBe(socket.OPEN))
  return socket
}

describe('MobileIrohFramedSocket', () => {
  beforeEach(async () => {
    messageListener = null
    closedListener = null
    vi.clearAllMocks()
    vi.mocked(AsyncStorage.getItem)
      .mockReset()
      .mockImplementation(async (key) => stored.get(key) ?? null)
    vi.mocked(AsyncStorage.setItem)
      .mockReset()
      .mockImplementation(async (key, value) => {
        stored.set(key, value)
      })
    vi.mocked(AsyncStorage.removeItem)
      .mockReset()
      .mockImplementation(async (key) => {
        stored.delete(key)
      })
    await saveIrohHomeRelayUrl(null)
    irohStart.mockReset().mockResolvedValue({ endpointId: 'b'.repeat(64) })
    irohConnect.mockReset().mockResolvedValue({ connectionId: 'conn-1' })
    irohStop.mockReset().mockResolvedValue()
    irohSend.mockReset().mockResolvedValue()
  })

  afterEach(() => {
    for (const socket of sockets) {
      socket.close()
    }
    sockets.length = 0
  })

  it('dials with the pairing-supplied hints and opens', async () => {
    const socket = createSocket({
      desktopEndpointId: endpointId,
      dialHints: {
        relayUrl: 'https://aps1-1.relay.n0.iroh.link./',
        directAddresses: ['192.168.1.9:41234', '[fe80::1%3]:41234', '[::ffff:192.0.2.1]:443']
      }
    })
    const onopen = vi.fn()
    socket.onopen = onopen

    await vi.waitFor(() => expect(onopen).toHaveBeenCalled())
    expect(irohConnect).toHaveBeenCalledWith(endpointId, {
      relayUrl: 'https://aps1-1.relay.n0.iroh.link./',
      directAddresses: ['192.168.1.9:41234', '[fe80::1%3]:41234', '[::ffff:192.0.2.1]:443']
    })
    expect(socket.readyState).toBe(socket.OPEN)
  })

  it.each([
    { dialHints: { relayUrl: 'not a URL' }, field: 'relayUrl' },
    { dialHints: { relayUrl: 'https://user:secret@relay.example/' }, field: 'relayUrl' },
    { dialHints: { directAddresses: ['old-hostname:443'] }, field: 'directAddresses' },
    {
      dialHints: { directAddresses: Array<string>(9).fill('192.168.1.9:41234') },
      field: 'directAddresses'
    }
  ])(
    'reports invalid persisted $field before calling native code',
    async ({ dialHints, field }) => {
      const onLog = vi.fn()
      const socket = createSocket({ desktopEndpointId: endpointId, dialHints, onLog })
      const onclose = vi.fn()
      const onerror = vi.fn()
      socket.onclose = onclose
      socket.onerror = onerror

      await vi.waitFor(() => expect(onclose).toHaveBeenCalled())

      expect(onclose).toHaveBeenCalledWith({
        code: 1006,
        reason: expect.stringContaining(`Invalid Iroh dial target: ${field}`)
      })
      expect(onerror).toHaveBeenCalledOnce()
      expect(onLog).toHaveBeenCalledWith(
        'Iroh start/connect failed',
        expect.stringContaining(`Invalid Iroh dial target: ${field}`)
      )
      expect(JSON.stringify(onLog.mock.calls)).not.toContain('secret')
      expect(irohStart).not.toHaveBeenCalled()
      expect(irohConnect).not.toHaveBeenCalled()
      expect(socket.readyState).toBe(socket.CLOSED)
    }
  )

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

  it('preserves an auth close emitted before the native connect promise resolves', async () => {
    const connected = Promise.withResolvers<{ connectionId: string }>()
    irohConnect.mockImplementationOnce(() => connected.promise)
    const socket = createSocket()
    const onopen = vi.fn()
    const onclose = vi.fn()
    socket.onopen = onopen
    socket.onclose = onclose
    await vi.waitFor(() => expect(irohConnect).toHaveBeenCalled())

    closedListener?.({ connectionId: 'other', reason: 'timed out' })
    closedListener?.({ connectionId: 'conn-1', reason: 'closed by peer: 4001: unauthorized' })
    connected.resolve({ connectionId: 'conn-1' })

    await vi.waitFor(() =>
      expect(onclose).toHaveBeenCalledWith({
        code: 4001,
        reason: 'closed by peer: 4001: unauthorized'
      })
    )
    expect(onopen).not.toHaveBeenCalled()
    expect(socket.readyState).toBe(socket.CLOSED)
    expect(irohClose).toHaveBeenCalledWith('conn-1')
  })

  it('ignores another connection closing while native connect is pending', async () => {
    const connected = Promise.withResolvers<{ connectionId: string }>()
    irohConnect.mockImplementationOnce(() => connected.promise)
    const socket = createSocket()
    const onclose = vi.fn()
    socket.onclose = onclose
    await vi.waitFor(() => expect(irohConnect).toHaveBeenCalled())

    closedListener?.({ connectionId: 'other', reason: 'closed by peer: 4001: unauthorized' })
    connected.resolve({ connectionId: 'conn-1' })

    await vi.waitFor(() => expect(socket.readyState).toBe(socket.OPEN))
    expect(onclose).not.toHaveBeenCalled()
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
    const socket = createSocket()
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
    const connected = Promise.withResolvers<{ connectionId: string }>()
    irohConnect.mockImplementationOnce(() => connected.promise)
    const socket = createSocket()
    await vi.waitFor(() => expect(irohConnect).toHaveBeenCalled())

    socket.close()
    connected.resolve({ connectionId: 'late-conn' })

    await vi.waitFor(() => expect(irohClose).toHaveBeenCalledWith('late-conn'))
  })

  it('keeps the live route until a relay save is durable, then cleanly reconnects', async () => {
    const socket = await openSocket()
    const onclose = vi.fn()
    const onerror = vi.fn()
    socket.onclose = onclose
    socket.onerror = onerror
    const written = Promise.withResolvers<void>()
    vi.mocked(AsyncStorage.setItem).mockImplementationOnce(async (key, value) => {
      await written.promise
      stored.set(key, value)
    })

    const saving = saveIrohHomeRelayUrl('https://aps1-1.relay.n0.iroh.link./')
    await Promise.resolve()
    expect(socket.readyState).toBe(socket.OPEN)
    expect(irohStop).not.toHaveBeenCalled()

    written.resolve()
    await saving
    expect(socket.readyState).toBe(socket.CLOSED)
    expect(onclose).toHaveBeenCalledWith({ code: 1000, reason: 'iroh_home_relay_changed' })
    expect(onerror).not.toHaveBeenCalled()

    const replacement = await openSocket()
    expect(replacement.readyState).toBe(replacement.OPEN)
    expect(irohStart).toHaveBeenLastCalledWith('https://aps1-1.relay.n0.iroh.link./')
  })

  it('leaves routing and an open socket unchanged when storage rejects the save', async () => {
    const socket = await openSocket()
    const onclose = vi.fn()
    socket.onclose = onclose
    vi.mocked(AsyncStorage.setItem).mockRejectedValueOnce(new Error('disk unavailable'))

    await expect(saveIrohHomeRelayUrl('https://relay.example/')).rejects.toThrow('disk unavailable')

    expect(socket.readyState).toBe(socket.OPEN)
    expect(onclose).not.toHaveBeenCalled()
    expect(irohStop).not.toHaveBeenCalled()
    await openSocket()
    expect(irohStart).toHaveBeenLastCalledWith(null)
  })

  it('invalidates a connecting socket and disposes its late connection after a saved change', async () => {
    const connected = Promise.withResolvers<{ connectionId: string }>()
    irohConnect.mockImplementationOnce(() => connected.promise)
    const remoteHints = {
      relayUrl: 'https://desktop-relay.example/',
      directAddresses: ['192.168.1.9:41234']
    }
    const socket = createSocket({ desktopEndpointId: endpointId, dialHints: remoteHints })
    const onopen = vi.fn()
    const onclose = vi.fn()
    socket.onopen = onopen
    socket.onclose = onclose
    await vi.waitFor(() => expect(irohConnect).toHaveBeenCalled())

    await saveIrohHomeRelayUrl('https://aps1-1.relay.n0.iroh.link./')
    expect(socket.readyState).toBe(socket.CLOSED)
    expect(onclose).toHaveBeenCalledWith({ code: 1000, reason: 'iroh_home_relay_changed' })
    connected.resolve({ connectionId: 'superseded-connection' })
    await vi.waitFor(() => expect(irohClose).toHaveBeenCalledWith('superseded-connection'))
    expect(onopen).not.toHaveBeenCalled()

    const replacement = createSocket({ desktopEndpointId: endpointId, dialHints: remoteHints })
    await vi.waitFor(() => expect(replacement.readyState).toBe(replacement.OPEN))
    expect(irohConnect).toHaveBeenLastCalledWith(endpointId, {
      relayUrl: 'https://desktop-relay.example/',
      directAddresses: ['192.168.1.9:41234']
    })
    expect(remoteHints).toEqual({
      relayUrl: 'https://desktop-relay.example/',
      directAddresses: ['192.168.1.9:41234']
    })
  })

  it('interrupts an old pending start before joining it and reads the latest saved choice', async () => {
    const started = Promise.withResolvers<{ endpointId: string }>()
    const stopped = Promise.withResolvers<void>()
    irohStart.mockImplementationOnce(() => started.promise)
    irohStop.mockImplementationOnce(async () => {
      started.resolve({ endpointId: 'b'.repeat(64) })
      await stopped.promise
    })
    const old = createSocket()
    await vi.waitFor(() => expect(irohStart).toHaveBeenCalledOnce())
    const queued = createSocket()

    await saveIrohHomeRelayUrl('https://aps1-1.relay.n0.iroh.link./')
    expect(irohStop).toHaveBeenCalledOnce()
    expect(old.readyState).toBe(old.CLOSED)
    expect(queued.readyState).toBe(queued.CLOSED)
    expect(irohConnect).not.toHaveBeenCalled()

    // No socket owns the earlier selection; the next dial must read again, not capture it.
    await saveIrohHomeRelayUrl('https://euw1-1.relay.n0.iroh.link./')
    const latest = createSocket()
    await Promise.resolve()
    expect(irohStart).toHaveBeenCalledOnce()
    stopped.resolve()
    await vi.waitFor(() => expect(latest.readyState).toBe(latest.OPEN))
    expect(irohStart).toHaveBeenCalledTimes(2)
    expect(irohStart).toHaveBeenLastCalledWith('https://euw1-1.relay.n0.iroh.link./')
    expect(irohConnect).toHaveBeenCalledOnce()
  })

  it('does not start or stop native networking for a saved choice without Iroh users', async () => {
    await saveIrohHomeRelayUrl('https://relay.example/')
    expect(irohStart).not.toHaveBeenCalled()
    expect(irohStop).not.toHaveBeenCalled()
  })

  it('drops queued writes when closed while a native send is pending', async () => {
    const socket = await openSocket()
    const started = Promise.withResolvers<void>()
    const sent = Promise.withResolvers<void>()
    const received: string[] = []
    irohSend.mockImplementation(async (_connectionId, b64) => {
      received.push(atob(b64))
    })
    irohSend.mockImplementationOnce(async (_connectionId, b64) => {
      started.resolve()
      await sent.promise
      received.push(atob(b64))
    })

    socket.send('first')
    await started.promise
    socket.send('queued')
    socket.close()
    socket.send('after-close')
    expect(socket.bufferedAmount).toBe(0)
    sent.resolve()

    await vi.waitFor(() => expect(received).toEqual(['first']))
    expect(socket.bufferedAmount).toBe(0)
  })

  it.each(['onerror', 'onclose'])(
    'reports a failed native send and discards queued frames even when %s throws',
    async (throwingCallback) => {
      const socket = await openSocket()
      const started = Promise.withResolvers<void>()
      const sent = Promise.withResolvers<void>()
      const received: string[] = []
      const onclose = vi.fn(() => {
        if (throwingCallback === 'onclose') {
          throw new Error('close callback failed')
        }
      })
      const onerror = vi.fn(() => {
        if (throwingCallback === 'onerror') {
          throw new Error('error callback failed')
        }
      })
      socket.onclose = onclose
      socket.onerror = onerror
      irohSend.mockImplementation(async (_connectionId, b64) => {
        received.push(atob(b64))
      })
      irohSend.mockImplementationOnce(async () => {
        started.resolve()
        await sent.promise
        throw new Error('write failed')
      })

      socket.send('first')
      await started.promise
      socket.send('queued')
      sent.resolve()

      await vi.waitFor(() =>
        expect(onclose).toHaveBeenCalledWith({ code: 1011, reason: 'iroh_send_failed' })
      )
      expect(onerror).toHaveBeenCalledOnce()
      expect(socket.readyState).toBe(socket.CLOSED)
      expect(socket.bufferedAmount).toBe(0)
      expect(received).toEqual([])
    }
  )
})
