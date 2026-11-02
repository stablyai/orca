import { EventEmitter, once } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { BrowserNetworkTunnelClient } from './browser-network-tunnel-client'
import type { BrowserNetworkTunnelDuplex } from './browser-network-tunnel-duplex'
import { BrowserNetworkTunnelSession } from './browser-network-tunnel-session'
import {
  BROWSER_NETWORK_TUNNEL_INITIAL_WINDOW_BYTES,
  type BrowserNetworkTunnelSocket
} from './browser-network-tunnel-stream-state'
import type { BrowserNetworkExecutionRoute } from './browser-network-execution-route'
import {
  BrowserNetworkTunnelStreamFrameDecoder,
  BrowserNetworkTunnelStreamFrameWriter
} from '../../shared/browser-network-tunnel-stream-framing'
import { resolveWslBrowserNetworkExecutionRoute } from './wsl-browser-network-execution-route'

class FakeDestination extends EventEmitter implements BrowserNetworkTunnelSocket {
  readonly writes: Uint8Array[] = []
  destroyed = false
  ended = false

  setNoDelay(): this {
    return this
  }
  pause(): this {
    return this
  }
  resume(): this {
    return this
  }
  write(bytes: Uint8Array, callback?: () => void): boolean {
    this.writes.push(bytes.slice())
    callback?.()
    return true
  }
  end(): this {
    this.ended = true
    return this
  }
  destroy(): this {
    this.destroyed = true
    return this
  }
}

class PacedDestination extends EventEmitter implements BrowserNetworkTunnelSocket {
  destroyed = false
  paused = true
  emitted = 0

  constructor(readonly payload: Buffer) {
    super()
  }

  accept(): this {
    setImmediate(() => this.emit('connect'))
    return this
  }

  setNoDelay(): this {
    return this
  }
  pause(): this {
    this.paused = true
    return this
  }
  resume(): this {
    if (this.paused) {
      this.paused = false
      setImmediate(() => this.pump())
    }
    return this
  }
  write(_bytes: Uint8Array, callback?: () => void): boolean {
    callback?.()
    return true
  }
  end(): this {
    return this
  }
  destroy(): this {
    this.destroyed = true
    return this
  }

  // One chunk per I/O turn, so the relay's frame writer drains as it would behind a real socket.
  private pump(): void {
    if (this.paused || this.destroyed || this.emitted >= this.payload.byteLength) {
      return
    }
    const chunk = this.payload.subarray(this.emitted, this.emitted + 16 * 1024)
    this.emitted += chunk.byteLength
    this.emit('data', chunk)
    setImmediate(() => this.pump())
  }
}

function createPairedClientThroughRoute(route: BrowserNetworkExecutionRoute) {
  let session: BrowserNetworkTunnelSession
  const client = new BrowserNetworkTunnelClient({
    tunnelGeneration: 3,
    sendBinary: (frame) => {
      setImmediate(() => session.handleBinary(frame))
      return true
    }
  })
  session = new BrowserNetworkTunnelSession({
    tunnelGeneration: 3,
    connect: (target) => route.connect(target),
    sendBinary: (frame) => {
      setImmediate(() => client.handleBinary(frame))
      return true
    }
  })
  return {
    client,
    close: () => {
      client.close()
      session.close()
    }
  }
}

function patternedPayload(bytes: number): Buffer {
  const payload = Buffer.alloc(bytes)
  for (let index = 0; index < bytes; index += 1) {
    payload[index] = (index * 31) % 251
  }
  return payload
}

async function waitForQuiescence(destination: PacedDestination): Promise<void> {
  const deadline = Date.now() + 5_000
  let previous = -1
  while (previous !== destination.emitted || !destination.paused) {
    if (destination.emitted >= destination.payload.byteLength) {
      throw new Error('destination emitted its whole payload without being paused')
    }
    if (Date.now() > deadline) {
      throw new Error(`destination never quiesced (emitted ${destination.emitted} bytes)`)
    }
    previous = destination.emitted
    for (let tick = 0; tick < 20; tick += 1) {
      await new Promise((resolve) => setImmediate(resolve))
    }
  }
}

function createRelayProcess(
  connect: (target: { host: string; port: number }) => BrowserNetworkTunnelSocket
) {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  let session: BrowserNetworkTunnelSession
  const input = new BrowserNetworkTunnelStreamFrameDecoder(
    (frame) => session.handleBinary(frame),
    () => session.close()
  )
  const stdin = new Writable({
    // Async like a real pipe: the relay session must not see host frames re-entrantly.
    write(chunk: Buffer, _encoding, callback) {
      setImmediate(() => {
        input.feed(chunk)
        callback()
      })
    }
  })
  const output = new BrowserNetworkTunnelStreamFrameWriter(
    (bytes, callback) => stdout.write(bytes, callback),
    () => session.close()
  )
  session = new BrowserNetworkTunnelSession({
    tunnelGeneration: 1,
    connect,
    sendBinary: (frame) => output.send(frame),
    onClose: () => stdout.end()
  })
  Object.assign(child, {
    stdin,
    stdout,
    stderr,
    killed: false,
    kill: vi.fn(() => {
      session.close()
      stdin.destroy()
      stdout.destroy()
      stderr.destroy()
      child.emit('close', 0, null)
      return true
    })
  })
  return child
}

const executionHost = {
  kind: 'wsl' as const,
  runtimeId: 'runtime-a',
  revision: 7,
  distro: 'Ubuntu'
}

describe('WSL browser network execution route', () => {
  it('keeps DNS, TCP data, and half-close inside the exact distro', async () => {
    const destination = new FakeDestination()
    const connect = vi.fn(() => destination)
    const child = createRelayProcess(connect)
    const launchRelay = vi.fn(async () => child)
    const route = await resolveWslBrowserNetworkExecutionRoute(
      { executionHost, runtimeId: 'runtime-a', runtimeRevision: 7 },
      { launchRelay }
    )

    const socket = route.connect({ host: 'split-horizon.internal', port: 8443 })
    socket.on('error', () => {})
    const connected = once(socket as unknown as EventEmitter, 'connect')
    await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce())
    expect(connect).toHaveBeenCalledWith({ host: 'split-horizon.internal', port: 8443 })
    destination.emit('connect')
    await connected
    expect(launchRelay).toHaveBeenCalledWith('Ubuntu', expect.any(AbortSignal))

    socket.write(new Uint8Array([1, 2, 3]))
    await vi.waitFor(() => expect(destination.writes).toEqual([new Uint8Array([1, 2, 3])]))
    socket.end()
    await vi.waitFor(() => expect(destination.ended).toBe(true))

    const received = once(socket as unknown as EventEmitter, 'data')
    destination.emit('data', new Uint8Array([4, 5]))
    await expect(received).resolves.toEqual([Buffer.from([4, 5])])
    await route.close()
    expect(child.kill).toHaveBeenCalledOnce()
  })

  it('rejects stale runtime identity before launching WSL', async () => {
    const launchRelay = vi.fn()
    await expect(
      resolveWslBrowserNetworkExecutionRoute(
        { executionHost, runtimeId: 'runtime-a', runtimeRevision: 8 },
        { launchRelay }
      )
    ).rejects.toThrow('browser_tunnel_execution_host_mismatch')
    expect(launchRelay).not.toHaveBeenCalled()
  })

  it('invalidates the route when the exact distro process exits', async () => {
    const child = createRelayProcess(() => new FakeDestination())
    const route = await resolveWslBrowserNetworkExecutionRoute(
      { executionHost, runtimeId: 'runtime-a', runtimeRevision: 7 },
      { launchRelay: async () => child }
    )

    child.emit('close', 1, null)
    await route.whenInvalidated
    expect(route.isValid()).toBe(false)
    const socket = route.connect({ host: 'must-not-fallback.internal', port: 443 })
    socket.on('error', () => {})
    await vi.waitFor(() => expect(socket.destroyed).toBe(true))
    await route.close()
  })

  it('delivers a response larger than the relay receive window', async () => {
    const payload = patternedPayload(4 * BROWSER_NETWORK_TUNNEL_INITIAL_WINDOW_BYTES)
    const destination = new PacedDestination(payload)
    const route = await resolveWslBrowserNetworkExecutionRoute(
      { executionHost, runtimeId: 'runtime-a', runtimeRevision: 7 },
      { launchRelay: async () => createRelayProcess(() => destination.accept()) }
    )

    const socket = route.connect({ host: 'large.internal', port: 443 })
    socket.on('error', () => {})
    const received: Buffer[] = []
    socket.on('data', (bytes) => received.push(Buffer.from(bytes)))

    await vi.waitFor(() => expect(Buffer.concat(received).byteLength).toBe(payload.byteLength), {
      timeout: 10_000
    })
    expect(Buffer.concat(received).equals(payload)).toBe(true)
    await route.close()
  })

  it('holds the WSL destination behind a stalled paired-client reader, then completes', async () => {
    const payload = patternedPayload(8 * BROWSER_NETWORK_TUNNEL_INITIAL_WINDOW_BYTES)
    const destination = new PacedDestination(payload)
    const route = await resolveWslBrowserNetworkExecutionRoute(
      { executionHost, runtimeId: 'runtime-a', runtimeRevision: 7 },
      { launchRelay: async () => createRelayProcess(() => destination.accept()) }
    )
    const paired = createPairedClientThroughRoute(route)
    const duplex: BrowserNetworkTunnelDuplex = await paired.client.open({
      host: 'large.internal',
      port: 443
    })
    duplex.on('error', () => {})

    await waitForQuiescence(destination)
    expect(destination.emitted).toBeGreaterThan(0)
    expect(destination.emitted).toBeLessThanOrEqual(3 * BROWSER_NETWORK_TUNNEL_INITIAL_WINDOW_BYTES)

    const received: Buffer[] = []
    duplex.on('data', (bytes: Buffer) => {
      received.push(bytes)
      duplex.settleRead(bytes.byteLength)
    })
    await vi.waitFor(() => expect(Buffer.concat(received).byteLength).toBe(payload.byteLength), {
      timeout: 10_000
    })
    expect(Buffer.concat(received).equals(payload)).toBe(true)
    paired.close()
    await route.close()
  })
})
