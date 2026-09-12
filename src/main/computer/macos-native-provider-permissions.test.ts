import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MacOSNativeProviderClient } from './macos-native-provider-client'

const { connectMock, spawnMock } = vi.hoisted(() => ({ connectMock: vi.fn(), spawnMock: vi.fn() }))
vi.mock('child_process', () => ({ spawn: spawnMock }))
vi.mock('fs', () => ({
  chmodSync: vi.fn(),
  mkdtempSync: vi.fn(() => '/tmp/orca-permission-test'),
  rmSync: vi.fn(),
  writeFileSync: vi.fn()
}))
vi.mock('./macos-native-provider-paths', () => ({
  resolveMacOSComputerUseExecutablePath: () =>
    '/Applications/Orca Computer Use.app/Contents/MacOS/orca-computer-use-macos'
}))
vi.mock('./macos-native-provider-socket', () => ({ connectMacOSProviderSocket: connectMock }))

class PermissionSocket extends EventEmitter {
  destroyed = false
  permissionStatus: boolean | undefined = true
  requests: string[] = []
  status = { accessibility: 'not-granted', screenshots: 'granted' }
  setEncoding(): void {}
  end(): void {
    this.destroyed = true
  }
  write(line: string, callback?: (error?: Error) => void): boolean {
    const request = JSON.parse(line)
    this.requests.push(request.method)
    const result =
      request.method === 'handshake'
        ? {
            protocolVersion: 1,
            supports: { observation: { permissionStatus: this.permissionStatus } }
          }
        : this.status
    queueMicrotask(() =>
      this.emit('data', `${JSON.stringify({ id: request.id, ok: true, result })}\n`)
    )
    callback?.()
    return true
  }
}

let client: MacOSNativeProviderClient
let socket: PermissionSocket
beforeEach(() => {
  socket = new PermissionSocket()
  connectMock.mockResolvedValue(socket)
  spawnMock.mockImplementation(() =>
    Object.assign(new EventEmitter(), { unref: vi.fn(), kill: vi.fn() })
  )
  client = new MacOSNativeProviderClient()
})
afterEach(() => {
  client.shutdown()
  vi.clearAllMocks()
})

describe('native execution permission status', () => {
  it('checks and refreshes permissions on the same socket used for observation', async () => {
    await client.snapshot({ app: 'com.apple.finder' })
    await expect(client.permissionsStatus()).resolves.toEqual(socket.status)
    socket.status = { accessibility: 'granted', screenshots: 'granted' }
    await expect(client.permissionsStatus()).resolves.toEqual(socket.status)
    expect(socket.requests).toEqual([
      'handshake',
      'getAppState',
      'permissionsStatus',
      'permissionsStatus'
    ])
    expect(connectMock).toHaveBeenCalledOnce()
    expect(spawnMock).toHaveBeenCalledOnce()
  })

  it.each([false, undefined])(
    'rejects helpers without permissionStatus support (%s)',
    async (supported) => {
      socket.permissionStatus = supported
      await expect(client.permissionsStatus()).rejects.toMatchObject({
        code: 'unsupported_capability'
      })
      expect(socket.requests).toEqual(['handshake'])
      expect(spawnMock).toHaveBeenCalledOnce()
    }
  )
})
