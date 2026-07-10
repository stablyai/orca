import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
  kill = vi.fn()
  unref = vi.fn()
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

    // Why: a timed-out helper socket can flush events after restart. Those
    // stale events must not clear/reject the active replacement request.
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

  it('starts a replacement socket after the active helper connection errors', async () => {
    const { MacOSNativeProviderClient } = await loadClientModule()
    const client = new MacOSNativeProviderClient()

    const firstCall = client.capabilities()
    const firstRejection = expect(firstCall).rejects.toThrow('active helper failed')
    await vi.waitFor(() => expect(sockets).toHaveLength(1))
    const firstSocket = sockets[0]!
    const firstSocketDirectory = mkdtempSyncMock.mock.results[0]?.value as string
    await vi.waitFor(() => expect(firstSocket.writes).toHaveLength(1))

    firstSocket.emit('error', new Error('active helper failed'))
    await firstRejection
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

  it('rejects actions that the native provider does not advertise', async () => {
    const { MacOSNativeProviderClient } = await loadClientModule()
    const client = new MacOSNativeProviderClient()

    const call = client.action('setValue', {
      app: 'TextEdit',
      elementIndex: 0,
      value: 'draft'
    })
    await vi.waitFor(() => expect(sockets).toHaveLength(1))
    const socket = sockets[0]!
    await vi.waitFor(() => expect(socket.writes).toHaveLength(1))
    const handshakeRequest = JSON.parse(socket.writes[0]!) as { id: number }

    socket.emit(
      'data',
      `${JSON.stringify({
        id: handshakeRequest.id,
        ok: true,
        result: macOSProviderCapabilities({ setValue: false })
      })}\n`
    )

    await expect(call).rejects.toMatchObject({
      code: 'unsupported_capability',
      message: expect.stringContaining('actions.setValue')
    })
    expect(socket.writes).toHaveLength(1)
  })

  it('rejects malformed action payloads before starting the native helper', async () => {
    const { MacOSNativeProviderClient } = await loadClientModule()
    const client = new MacOSNativeProviderClient()

    await expect(client.action('click', { elementIndex: 0 })).rejects.toMatchObject({
      code: 'invalid_argument',
      message: expect.stringContaining('Missing app')
    })
    await expect(client.action('click', { app: 'TextEdit' })).rejects.toMatchObject({
      code: 'invalid_argument',
      message: expect.stringContaining('Click requires')
    })
    await expect(client.action('typeText', { app: 'TextEdit', text: '' })).rejects.toMatchObject({
      code: 'invalid_argument',
      message: expect.stringContaining('Missing text')
    })
    await expect(
      client.action('pressKey', { app: 'TextEdit', key: 'CmdOrCtrl+V' })
    ).rejects.toMatchObject({
      code: 'invalid_argument',
      message: expect.stringContaining('Press-key accepts one key only')
    })
    await expect(client.action('hotkey', { app: 'TextEdit', key: 'A' })).rejects.toMatchObject({
      code: 'invalid_argument',
      message: expect.stringContaining('Hotkey requires')
    })

    expect(providers).toHaveLength(0)
    expect(sockets).toHaveLength(0)
    expect(spawnMock).not.toHaveBeenCalled()
    expect(connectMacOSProviderSocketMock).not.toHaveBeenCalled()
  })

  it('normalizes unverified synthetic native action results', async () => {
    const { MacOSNativeProviderClient } = await loadClientModule()
    const client = new MacOSNativeProviderClient()

    const call = client.action('click', {
      app: 'TextEdit',
      elementIndex: 0
    })
    await vi.waitFor(() => expect(sockets).toHaveLength(1))
    const socket = sockets[0]!
    await vi.waitFor(() => expect(socket.writes).toHaveLength(1))
    const handshakeRequest = JSON.parse(socket.writes[0]!) as { id: number }

    socket.emit(
      'data',
      `${JSON.stringify({
        id: handshakeRequest.id,
        ok: true,
        result: macOSProviderCapabilities()
      })}\n`
    )
    await vi.waitFor(() => expect(socket.writes).toHaveLength(2))
    const actionRequest = JSON.parse(socket.writes[1]!) as { id: number }
    socket.emit(
      'data',
      `${JSON.stringify({
        id: actionRequest.id,
        ok: true,
        result: {
          snapshot: {},
          action: { path: 'synthetic', actionName: null, fallbackReason: null }
        }
      })}\n`
    )

    await expect(call).resolves.toMatchObject({
      action: {
        path: 'synthetic',
        verification: { state: 'unverified', reason: 'synthetic_input' }
      }
    })
  })

  it('removes the parent-owned token file after the helper socket connects', async () => {
    const { MacOSNativeProviderClient } = await loadClientModule()
    const client = new MacOSNativeProviderClient()

    const call = client.capabilities()
    await vi.waitFor(() => expect(sockets).toHaveLength(1))
    const socket = sockets[0]!
    await vi.waitFor(() => expect(socket.writes).toHaveLength(1))
    const request = JSON.parse(socket.writes[0]!) as { id: number }
    const socketDirectory = mkdtempSyncMock.mock.results[0]?.value as string

    expect(rmSyncMock).toHaveBeenCalledWith(join(socketDirectory, 'provider.token'), {
      force: true
    })

    socket.emit(
      'data',
      `${JSON.stringify({
        id: request.id,
        ok: true,
        result: { protocolVersion: 1, supports: {} }
      })}\n`
    )
    await expect(call).resolves.toMatchObject({ protocolVersion: 1 })
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

  it('terminates the helper process when socket startup fails', async () => {
    const providerKill = vi.fn()
    spawnMock.mockReturnValueOnce({ unref: vi.fn(), kill: providerKill })
    connectMacOSProviderSocketMock.mockRejectedValueOnce(new Error('socket did not open'))
    const { MacOSNativeProviderClient } = await loadClientModule()
    const client = new MacOSNativeProviderClient()

    await expect(client.capabilities()).rejects.toThrow('socket did not open')

    expect(providerKill).toHaveBeenCalledWith('SIGTERM')
    expect(rmSyncMock).toHaveBeenCalledWith(expect.stringContaining('orca-computer-use-'), {
      recursive: true,
      force: true
    })
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

  it('rejects helper exits before socket connection and aborts the pending connect', async () => {
    const { MacOSNativeProviderClient } = await loadClientModule()
    const client = new MacOSNativeProviderClient()
    connectMacOSProviderSocketMock.mockImplementation((_path, _timeout, signal?: AbortSignal) =>
      pendingConnectThatRejectsOnAbort(signal)
    )

    const call = client.capabilities()
    await vi.waitFor(() => expect(providers).toHaveLength(1))
    const connectSignal = connectMacOSProviderSocketMock.mock.calls[0]?.[2] as AbortSignal
    providers[0]!.emit('exit', 13, null)

    await expect(call).rejects.toThrow('native macOS helper app exited before connecting: code 13')
    expect(connectSignal.aborted).toBe(true)
    expect(providers[0]!.kill).toHaveBeenCalledWith('SIGTERM')
  })
})

function macOSProviderCapabilities(actions: Partial<Record<string, boolean>> = {}) {
  return {
    platform: 'darwin',
    provider: 'orca-computer-use-macos',
    providerVersion: '1.0.0',
    protocolVersion: 1,
    supports: {
      apps: { list: true, bundleIds: true, pids: true },
      windows: {
        list: true,
        targetById: true,
        targetByIndex: true,
        focus: false,
        moveResize: false
      },
      observation: {
        screenshot: true,
        annotatedScreenshot: false,
        elementFrames: true,
        ocr: false
      },
      actions: {
        click: true,
        typeText: true,
        pressKey: true,
        hotkey: true,
        pasteText: true,
        scroll: true,
        drag: true,
        setValue: true,
        performAction: true,
        ...actions
      },
      surfaces: { menus: false, dialogs: false, dock: false, menubar: false }
    }
  }
}
