import { EventEmitter, once } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { BrowserNetworkTunnelSession } from './browser-network-tunnel-session'
import type { BrowserNetworkTunnelSocket } from './browser-network-tunnel-stream-state'
import {
  BrowserNetworkTunnelStreamFrameDecoder,
  encodeBrowserNetworkTunnelStreamFrame
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

function createRelayProcess(connect: (target: { host: string; port: number }) => FakeDestination) {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  let session: BrowserNetworkTunnelSession
  const input = new BrowserNetworkTunnelStreamFrameDecoder(
    (frame) => session.handleBinary(frame),
    () => session.close()
  )
  const stdin = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      input.feed(chunk)
      callback()
    }
  })
  session = new BrowserNetworkTunnelSession({
    tunnelGeneration: 1,
    connect,
    sendBinary: (frame) => stdout.write(encodeBrowserNetworkTunnelStreamFrame(frame)),
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
})
