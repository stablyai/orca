import { EventEmitter } from 'events'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

const { existsSyncMock, spawnMock, connectMock } = vi.hoisted(() => ({
  existsSyncMock: vi.fn(),
  spawnMock: vi.fn(),
  connectMock: vi.fn()
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
  connect: connectMock
}))

import {
  SYSTEM_SSH_FORWARD_LISTENER_PROBE_INTERVAL_MS,
  SYSTEM_SSH_FORWARD_STARTUP_GRACE_MS,
  spawnSystemSshPortForward,
  waitForSystemSshForwardStartup,
  waitForSystemSshForwardStop
} from './system-ssh-forward-process'
import type { SshTarget } from '../../shared/ssh-types'

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

function mockSystemSshExists(): void {
  existsSyncMock.mockImplementation((p: string) => p === SYSTEM_SSH_PATH)
}

describe('system SSH forward process', () => {
  beforeEach(() => {
    existsSyncMock.mockReset()
    spawnMock.mockReset()
    connectMock.mockReset()
    mockSystemSshExists()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('spawns port forwards before the ssh destination terminator', () => {
    spawnMock.mockReturnValue(createFakeProcess())

    spawnSystemSshPortForward(createTarget({ configHost: 'fdpass-host' }), 5173, '127.0.0.1', 3000)

    expect(spawnMock).toHaveBeenCalledWith(
      SYSTEM_SSH_PATH,
      [
        '-o',
        'BatchMode=no',
        '-T',
        '-N',
        '-o',
        'ExitOnForwardFailure=yes',
        '-L',
        '127.0.0.1:5173:127.0.0.1:3000',
        '--',
        'deploy@fdpass-host'
      ],
      expect.objectContaining({ stdio: ['ignore', 'ignore', 'pipe'] })
    )
  })

  it('preserves manual target port and identity options in the forwarded ssh command', () => {
    spawnMock.mockReturnValue(createFakeProcess())

    spawnSystemSshPortForward(
      createTarget({ port: 2222, identityFile: '/home/user/.ssh/id_ed25519' }),
      5173,
      '127.0.0.1',
      3000
    )

    const args = spawnMock.mock.calls[0][1] as string[]
    expect(args).toEqual(expect.arrayContaining(['-p', '2222', '-i', '/home/user/.ssh/id_ed25519']))
    expect(args).toContain('deploy@example.com')
  })

  it('rejects startup when ssh exits early with stderr', async () => {
    vi.useFakeTimers()
    const child = createFakeProcess()
    const socket = createFakeSocket()
    connectMock.mockReturnValue(socket)

    const pending = waitForSystemSshForwardStartup(child as never, 3000)
    child.stderr.emit('data', Buffer.from('bind: Address already in use\n'))
    child.emit('exit', 255)

    await expect(pending).rejects.toThrow('bind: Address already in use')
  })

  it('rejects startup when the ssh process emits an error', async () => {
    vi.useFakeTimers()
    const child = createFakeProcess()
    connectMock.mockReturnValue(createFakeSocket())

    const pending = waitForSystemSshForwardStartup(child as never, 3000)
    child.emit('error', new Error('spawn failed'))

    await expect(pending).rejects.toThrow('spawn failed')
  })

  it('resolves startup when the local listener probe connects', async () => {
    vi.useFakeTimers()
    const child = createFakeProcess()
    const socket = createFakeSocket()
    connectMock.mockReturnValue(socket)

    const pending = waitForSystemSshForwardStartup(child as never, 3000)
    await vi.advanceTimersByTimeAsync(SYSTEM_SSH_FORWARD_LISTENER_PROBE_INTERVAL_MS)
    socket.emit('connect')

    await expect(pending).resolves.toBeUndefined()
    expect(socket.destroy).toHaveBeenCalled()
  })

  it('resolves startup after the grace period when ssh keeps running', async () => {
    vi.useFakeTimers()
    const child = createFakeProcess()
    connectMock.mockImplementation(() => {
      const socket = createFakeSocket()
      queueMicrotask(() => socket.emit('error', new Error('ECONNREFUSED')))
      return socket
    })

    const pending = waitForSystemSshForwardStartup(child as never, 3000)
    await vi.advanceTimersByTimeAsync(SYSTEM_SSH_FORWARD_STARTUP_GRACE_MS)

    await expect(pending).resolves.toBeUndefined()
  })

  it('sends SIGTERM then SIGKILL when the process does not exit', async () => {
    vi.useFakeTimers()
    const child = createFakeProcess()

    const pending = waitForSystemSshForwardStop(child as never)
    await vi.advanceTimersByTimeAsync(2_000)

    expect(child.kill).toHaveBeenNthCalledWith(1, 'SIGTERM')
    expect(child.kill).toHaveBeenNthCalledWith(2, 'SIGKILL')

    child.emit('exit', null)
    await expect(pending).resolves.toBeUndefined()
  })

  it('does not resolve stop until the process exits', async () => {
    vi.useFakeTimers()
    const child = createFakeProcess()

    let resolved = false
    const pending = waitForSystemSshForwardStop(child as never).then(() => {
      resolved = true
    })

    await vi.advanceTimersByTimeAsync(1_999)
    expect(resolved).toBe(false)

    child.emit('exit', null)
    await pending
    expect(resolved).toBe(true)
  })
})
