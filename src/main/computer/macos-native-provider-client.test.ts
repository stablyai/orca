import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PROVIDER_SIGKILL_GRACE_MS } from './macos-native-provider-process-reaping'

const {
  chmodSyncMock,
  connectMacOSProviderSocketMock,
  mkdtempSyncMock,
  resolveMacOSComputerUseExecutablePathMock,
  rmSyncMock,
  spawnMock,
  writeFileSyncMock
} = vi.hoisted(() => ({
  chmodSyncMock: vi.fn(),
  connectMacOSProviderSocketMock: vi.fn(),
  mkdtempSyncMock: vi.fn(),
  resolveMacOSComputerUseExecutablePathMock: vi.fn(),
  rmSyncMock: vi.fn(),
  spawnMock: vi.fn(),
  writeFileSyncMock: vi.fn()
}))

vi.mock('child_process', () => ({
  spawn: spawnMock
}))

vi.mock('fs', () => ({
  chmodSync: chmodSyncMock,
  mkdtempSync: mkdtempSyncMock,
  rmSync: rmSyncMock,
  writeFileSync: writeFileSyncMock
}))

vi.mock('./macos-native-provider-paths', () => ({
  resolveMacOSComputerUseExecutablePath: resolveMacOSComputerUseExecutablePathMock
}))

vi.mock('./macos-native-provider-socket', () => ({
  connectMacOSProviderSocket: connectMacOSProviderSocketMock
}))

class FakeSocket extends EventEmitter {
  destroyed = false
  writes: string[] = []
  writeError: Error | null = null

  setEncoding(): void {}

  write(line: string, callback?: (error?: Error | null) => void): boolean {
    this.writes.push(line)
    callback?.(this.writeError)
    return true
  }

  end(): void {
    this.destroyed = true
  }

  destroy(): this {
    this.destroyed = true
    return this
  }
}

class FakeProvider extends EventEmitter {
  exitCode: number | null = null
  signalCode: string | null = null
  kill = vi.fn()
  unref = vi.fn()

  exit(code = 0): void {
    this.exitCode = code
    this.emit('exit', code, null)
  }
}

function pendingConnectThatRejectsOnAbort(signal?: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal?.addEventListener(
      'abort',
      () => reject(new Error('native macOS helper app startup was cancelled')),
      { once: true }
    )
  })
}

async function loadClientModule() {
  vi.resetModules()
  return await import('./macos-native-provider-client')
}

describe('MacOSNativeProviderClient', () => {
  const sockets: FakeSocket[] = []
  const providers: FakeProvider[] = []

  beforeEach(() => {
    vi.useFakeTimers()
    sockets.length = 0
    providers.length = 0
    mkdtempSyncMock.mockImplementation((prefix: string) => `${prefix}${sockets.length}`)
    resolveMacOSComputerUseExecutablePathMock.mockReturnValue(
      '/Applications/Orca Computer Use.app/Contents/MacOS/orca-computer-use-macos'
    )
    spawnMock.mockImplementation(() => {
      const provider = new FakeProvider()
      providers.push(provider)
      return provider
    })
    connectMacOSProviderSocketMock.mockImplementation(async () => {
      const socket = new FakeSocket()
      sockets.push(socket)
      return socket
    })
  })

  afterEach(() => {
    for (const result of spawnMock.mock.results) {
      if (result.value instanceof FakeProvider) {
        result.value.exit()
      }
    }
    chmodSyncMock.mockReset()
    connectMacOSProviderSocketMock.mockReset()
    mkdtempSyncMock.mockReset()
    resolveMacOSComputerUseExecutablePathMock.mockReset()
    rmSyncMock.mockReset()
    spawnMock.mockReset()
    writeFileSyncMock.mockReset()
    vi.useRealTimers()
  })

  it('ignores stale socket data, close, and error after a replacement socket starts', async () => {
    const { MacOSNativeProviderClient } = await loadClientModule()
    const client = new MacOSNativeProviderClient()

    const firstCall = client.capabilities()
    const firstRejection = expect(firstCall).rejects.toThrow(
      'native macOS provider handshake timed out'
    )
    await vi.waitFor(() => expect(sockets).toHaveLength(1))
    const firstSocket = sockets[0]!

    firstSocket.emit('data', '{"id":999,"result":"partial')
    await vi.advanceTimersByTimeAsync(60_000)
    await firstRejection
    expect(firstSocket.destroyed).toBe(true)
    expect(firstSocket.listenerCount('data')).toBe(0)
    expect(firstSocket.listenerCount('close')).toBe(0)
    expect(firstSocket.listenerCount('error')).toBe(1)

    const secondCall = client.capabilities()
    await vi.waitFor(() => expect(sockets).toHaveLength(2))
    const secondSocket = sockets[1]!
    await vi.waitFor(() => expect(secondSocket.writes).toHaveLength(1))
    const secondRequest = JSON.parse(secondSocket.writes[0]!) as { id: number }

    firstSocket.emit('data', '{"id":999,"ok":false,"error":{"code":"old","message":"old"}}\n')
    expect(() => firstSocket.emit('error', new Error('old helper failed late'))).not.toThrow()
    firstSocket.emit('close')

    const capabilities = {
      protocolVersion: 1,
      supports: {}
    }
    secondSocket.emit(
      'data',
      `${JSON.stringify({ id: secondRequest.id, ok: true, result: capabilities })}\n`
    )

    await expect(secondCall).resolves.toEqual(capabilities)
  })

  it('invalidates the active socket when a helper write fails', async () => {
    const { MacOSNativeProviderClient } = await loadClientModule()
    const client = new MacOSNativeProviderClient()

    const firstCall = client.capabilities()
    await vi.waitFor(() => expect(sockets).toHaveLength(1))
    const firstSocket = sockets[0]!
    const firstSocketDirectory = mkdtempSyncMock.mock.results[0]?.value as string
    firstSocket.writeError = new Error('write EPIPE')

    await expect(firstCall).rejects.toThrow('write EPIPE')
    expect(firstSocket.destroyed).toBe(true)
    expect(firstSocket.listenerCount('data')).toBe(0)
    expect(firstSocket.listenerCount('close')).toBe(0)
    expect(firstSocket.listenerCount('error')).toBe(1)
    expect(rmSyncMock).toHaveBeenCalledWith(firstSocketDirectory, {
      recursive: true,
      force: true
    })

    const secondCall = client.capabilities()
    await vi.waitFor(() => expect(sockets).toHaveLength(2))
    const secondSocket = sockets[1]!
    await vi.waitFor(() => expect(secondSocket.writes).toHaveLength(1))
    const secondRequest = JSON.parse(secondSocket.writes[0]!) as { id: number }
    secondSocket.emit(
      'data',
      `${JSON.stringify({
        id: secondRequest.id,
        ok: true,
        result: { protocolVersion: 1, supports: {} }
      })}\n`
    )

    await expect(secondCall).resolves.toMatchObject({ protocolVersion: 1 })
  })

  it('does not let a superseded startup clean up the replacement helper token', async () => {
    const pendingConnects: {
      resolve: (socket: FakeSocket) => void
    }[] = []
    connectMacOSProviderSocketMock.mockImplementation(
      async () =>
        await new Promise<FakeSocket>((resolve) => {
          pendingConnects.push({ resolve })
        })
    )
    const { MacOSNativeProviderClient } = await loadClientModule()
    const client = new MacOSNativeProviderClient()

    const firstCall = client.capabilities()
    await vi.waitFor(() => expect(pendingConnects).toHaveLength(1))
    const firstSocketDirectory = mkdtempSyncMock.mock.results[0]?.value as string

    client.shutdown()

    const secondCall = client.capabilities()
    await vi.waitFor(() => expect(pendingConnects).toHaveLength(2))
    const secondSocket = new FakeSocket()
    pendingConnects[1]!.resolve(secondSocket)
    await vi.waitFor(() => expect(secondSocket.writes).toHaveLength(1))
    const secondRequest = JSON.parse(secondSocket.writes[0]!) as { id: number }

    const firstSocket = new FakeSocket()
    pendingConnects[0]!.resolve(firstSocket)

    await expect(firstCall).rejects.toThrow('native macOS provider startup was superseded')
    expect(firstSocket.destroyed).toBe(true)
    expect(rmSyncMock).toHaveBeenCalledWith(join(firstSocketDirectory, 'provider.token'), {
      force: true
    })

    secondSocket.emit(
      'data',
      `${JSON.stringify({
        id: secondRequest.id,
        ok: true,
        result: { protocolVersion: 1, supports: {} }
      })}\n`
    )
    await expect(secondCall).resolves.toMatchObject({ protocolVersion: 1 })
  })

  it('rejects helper spawn errors before socket connection and removes temp state', async () => {
    const { MacOSNativeProviderClient } = await loadClientModule()
    const client = new MacOSNativeProviderClient()
    connectMacOSProviderSocketMock.mockImplementation((_path, _timeout, signal?: AbortSignal) =>
      pendingConnectThatRejectsOnAbort(signal)
    )

    const call = client.capabilities()
    await vi.waitFor(() => expect(providers).toHaveLength(1))
    const socketDirectory = mkdtempSyncMock.mock.results[0]?.value as string
    const connectSignal = connectMacOSProviderSocketMock.mock.calls[0]?.[2] as AbortSignal
    expect(connectSignal.aborted).toBe(false)
    providers[0]!.emit('error', new Error('helper missing'))

    await expect(call).rejects.toThrow('native macOS helper app failed to start: helper missing')
    expect(connectSignal.aborted).toBe(true)
    expect(providers[0]!.kill).toHaveBeenCalledWith('SIGTERM')
    expect(rmSyncMock).toHaveBeenCalledWith(socketDirectory, {
      recursive: true,
      force: true
    })
  })

  it('escalates to SIGKILL when a helper ignores terminate and SIGTERM', async () => {
    const { MacOSNativeProviderClient } = await loadClientModule()
    const client = new MacOSNativeProviderClient()

    const call = client.capabilities()
    const rejection = expect(call).rejects.toThrow('native macOS provider handshake timed out')
    await vi.waitFor(() => expect(sockets).toHaveLength(1))
    const socket = sockets[0]!
    await vi.waitFor(() => expect(socket.writes).toHaveLength(1))

    await vi.advanceTimersByTimeAsync(60_000)
    await rejection

    const provider = providers[0]!
    // Socket termination cannot stop a helper wedged in a native call; signal it too.
    expect(socket.writes.at(-1)).toContain('"method":"terminate"')
    expect(provider.kill).toHaveBeenCalledWith('SIGTERM')
    expect(provider.kill).not.toHaveBeenCalledWith('SIGKILL')

    await vi.advanceTimersByTimeAsync(PROVIDER_SIGKILL_GRACE_MS)
    expect(provider.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('does not escalate to SIGKILL when the helper exits after SIGTERM', async () => {
    const { MacOSNativeProviderClient } = await loadClientModule()
    const client = new MacOSNativeProviderClient()

    const call = client.capabilities()
    const rejection = expect(call).rejects.toThrow('native macOS provider handshake timed out')
    await vi.waitFor(() => expect(sockets).toHaveLength(1))
    await vi.waitFor(() => expect(sockets[0]!.writes).toHaveLength(1))

    await vi.advanceTimersByTimeAsync(60_000)
    await rejection

    const provider = providers[0]!
    expect(provider.kill).toHaveBeenCalledWith('SIGTERM')
    provider.exit(0)

    await vi.advanceTimersByTimeAsync(PROVIDER_SIGKILL_GRACE_MS * 2)
    expect(provider.kill).not.toHaveBeenCalledWith('SIGKILL')
  })

  it('reaps the helper process of a superseded startup', async () => {
    const pendingConnects: {
      resolve: (socket: FakeSocket) => void
    }[] = []
    connectMacOSProviderSocketMock.mockImplementation(
      async () =>
        await new Promise<FakeSocket>((resolve) => {
          pendingConnects.push({ resolve })
        })
    )
    const { MacOSNativeProviderClient } = await loadClientModule()
    const client = new MacOSNativeProviderClient()

    const firstCall = client.capabilities()
    await vi.waitFor(() => expect(pendingConnects).toHaveLength(1))

    client.shutdown()

    const secondCall = client.capabilities()
    await vi.waitFor(() => expect(pendingConnects).toHaveLength(2))
    const secondSocket = new FakeSocket()
    pendingConnects[1]!.resolve(secondSocket)
    await vi.waitFor(() => expect(secondSocket.writes).toHaveLength(1))
    const secondRequest = JSON.parse(secondSocket.writes[0]!) as { id: number }

    pendingConnects[0]!.resolve(new FakeSocket())
    await expect(firstCall).rejects.toThrow('native macOS provider startup was superseded')

    expect(providers[0]!.kill).toHaveBeenCalledTimes(1)
    expect(providers[0]!.kill).toHaveBeenCalledWith('SIGTERM')
    expect(providers[1]!.kill).not.toHaveBeenCalled()

    secondSocket.emit(
      'data',
      `${JSON.stringify({
        id: secondRequest.id,
        ok: true,
        result: { protocolVersion: 1, supports: {} }
      })}\n`
    )
    await expect(secondCall).resolves.toMatchObject({ protocolVersion: 1 })
  })
})
