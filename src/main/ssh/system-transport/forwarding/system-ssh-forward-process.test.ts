import { EventEmitter } from 'node:events'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

const {
  existsSyncMock,
  spawnMock,
  connectMock,
  createServerMock,
  stopOrphanMock,
  cancelMuxedMock
} = vi.hoisted(() => ({
  existsSyncMock: vi.fn(),
  spawnMock: vi.fn(),
  connectMock: vi.fn(),
  createServerMock: vi.fn(),
  stopOrphanMock: vi.fn(),
  cancelMuxedMock: vi.fn()
}))

vi.mock('./system-ssh-orphaned-forward', () => ({
  stopOrphanedOrcaSshForward: stopOrphanMock
}))

vi.mock('./system-ssh-muxed-forward-cancel', () => ({
  cancelMuxedLocalForward: cancelMuxedMock
}))

vi.mock('fs', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    existsSync: existsSyncMock
  }
})

vi.mock('child_process', () => ({
  spawn: spawnMock
}))

vi.mock('net', () => ({
  connect: connectMock,
  createServer: createServerMock
}))

import {
  SYSTEM_SSH_FORWARD_STARTUP_GRACE_MS,
  startSystemSshPortForwardProcess,
  waitForSystemSshForwardStartup
} from './system-ssh-forward-process'
import type { SshTarget } from '../../../../shared/ssh-types'

const SYSTEM_SSH_PATH =
  process.platform === 'win32' ? 'C:\\Windows\\System32\\OpenSSH\\ssh.exe' : '/usr/bin/ssh'

type FakeChildProcess = EventEmitter & {
  stderr: EventEmitter
  kill: ReturnType<typeof vi.fn>
  exitCode: number | null
  signalCode: NodeJS.Signals | null
}

type FakeSocket = EventEmitter & {
  setTimeout: ReturnType<typeof vi.fn>
  destroy: ReturnType<typeof vi.fn>
}

function createTarget(overrides?: Partial<SshTarget>): SshTarget {
  return {
    id: 'target-1',
    label: 'Test Server',
    host: 'example.com',
    port: 22,
    username: 'deploy',
    ...overrides
  }
}

function createFakeProcess(): FakeChildProcess {
  const child = new EventEmitter() as FakeChildProcess
  child.stderr = new EventEmitter()
  child.kill = vi.fn().mockReturnValue(true)
  child.exitCode = null
  child.signalCode = null
  return child
}

function createFakeSocket(): FakeSocket {
  const socket = new EventEmitter() as FakeSocket
  socket.setTimeout = vi.fn()
  socket.destroy = vi.fn()
  return socket
}

function createFakeServer() {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fields are assigned on the next lines, before the server is returned.
  const server = new EventEmitter() as EventEmitter & {
    listen: ReturnType<typeof vi.fn>
    close: ReturnType<typeof vi.fn>
    address: ReturnType<typeof vi.fn>
  }
  let boundPort = 0
  server.listen = vi.fn().mockImplementation((port: number) => {
    boundPort = port === 0 ? 49800 : port
    queueMicrotask(() => server.emit('listening'))
    return server
  })
  server.address = vi.fn(() => ({ address: '127.0.0.1', port: boundPort }))
  server.close = vi.fn().mockImplementation((cb?: () => void) => cb?.())
  return server
}

function mockSystemSshExists(): void {
  existsSyncMock.mockImplementation((p: string) => p === SYSTEM_SSH_PATH)
}

describe('system SSH forward process', () => {
  beforeEach(() => {
    existsSyncMock.mockReset()
    spawnMock.mockReset()
    connectMock.mockReset()
    createServerMock.mockReset().mockImplementation(createFakeServer)
    stopOrphanMock.mockReset().mockResolvedValue(false)
    cancelMuxedMock.mockReset().mockResolvedValue(false)
    mockSystemSshExists()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps the port error when nothing Orca orphaned holds the port', async () => {
    const server = createFakeServer()
    server.listen.mockImplementation(() => {
      queueMicrotask(() =>
        server.emit('error', Object.assign(new Error('EADDRINUSE'), { code: 'EADDRINUSE' }))
      )
      return server
    })
    createServerMock.mockReturnValue(server)

    await expect(
      startSystemSshPortForwardProcess(createTarget(), 5173, '127.0.0.1', 3000)
    ).rejects.toThrow('Local port 127.0.0.1:5173 is not available')
    expect(stopOrphanMock).toHaveBeenCalledWith(5173, expect.any(Array))
    expect(cancelMuxedMock).not.toHaveBeenCalled()
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it("rejects startup and stops ssh when it cannot listen on this forward's own port", async () => {
    const child = createFakeProcess()
    spawnMock.mockReturnValue(child)
    connectMock.mockReturnValue(createFakeSocket())
    const forward = await startSystemSshPortForwardProcess(createTarget(), 5173, '127.0.0.1', 3000)

    const pending = forward.waitForStartup()
    child.stderr.emit('data', Buffer.from('bind [127.0.0.1]:5173: Address already in use\n'))
    child.stderr.emit('data', Buffer.from('channel_setup_fwd_listener_tcpip: cannot listen'))
    child.stderr.emit('data', Buffer.from(' to port: 5173\n'))
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    child.emit('exit', null)

    await expect(pending).rejects.toThrow('cannot listen to port: 5173')
  })

  it('keeps running when only an ssh_config forward cannot listen', async () => {
    vi.useFakeTimers()
    const child = createFakeProcess()
    spawnMock.mockReturnValue(child)
    connectMock.mockImplementation(() => {
      const socket = createFakeSocket()
      queueMicrotask(() => socket.emit('error', new Error('ECONNREFUSED')))
      return socket
    })
    const forward = await startSystemSshPortForwardProcess(createTarget(), 5173, '127.0.0.1', 3000)

    const pending = forward.waitForStartup()
    child.stderr.emit(
      'data',
      Buffer.from(
        'bind [127.0.0.1]:51730: Address already in use\n' +
          'channel_setup_fwd_listener_tcpip: cannot listen to port: 51730\n' +
          'Could not request local forwarding.\n'
      )
    )
    await vi.advanceTimersByTimeAsync(SYSTEM_SSH_FORWARD_STARTUP_GRACE_MS)

    await expect(pending).resolves.toBeUndefined()
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('rejects when no listener appears within the listener timeout', async () => {
    vi.useFakeTimers()
    const child = createFakeProcess()
    connectMock.mockImplementation(() => {
      const socket = createFakeSocket()
      queueMicrotask(() => socket.emit('error', new Error('ECONNREFUSED')))
      return socket
    })

    spawnMock.mockReturnValue(child)
    const forward = await startSystemSshPortForwardProcess(createTarget(), 5173, '127.0.0.1', 3000)

    const pending = waitForSystemSshForwardStartup(forward.process, 5173, 5_000)
    const assertion = expect(pending).rejects.toThrow('did not listen on 127.0.0.1:5173')
    await vi.advanceTimersByTimeAsync(5_000)
    await assertion
  })
})
