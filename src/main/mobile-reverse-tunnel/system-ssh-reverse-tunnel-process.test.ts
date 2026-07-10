import { EventEmitter } from 'node:events'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

const { existsSyncMock, spawnMock, connectMock } = vi.hoisted(() => ({
  existsSyncMock: vi.fn(),
  spawnMock: vi.fn(),
  connectMock: vi.fn()
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    existsSync: existsSyncMock
  }
})

vi.mock('node:child_process', () => ({
  spawn: spawnMock
}))

vi.mock('node:net', () => ({
  connect: connectMock
}))

import {
  SYSTEM_SSH_REVERSE_TUNNEL_ENDPOINT_PROBE_INTERVAL_MS,
  SYSTEM_SSH_REVERSE_TUNNEL_STARTUP_GRACE_MS,
  SYSTEM_SSH_REVERSE_TUNNEL_STOP_TIMEOUT_MS,
  spawnSystemSshReverseTunnel,
  waitForSystemSshReverseTunnelStartup,
  waitForSystemSshReverseTunnelStop
} from './system-ssh-reverse-tunnel-process'
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
    label: 'Relay',
    host: 'relay.example.com',
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

describe('system SSH reverse tunnel process', () => {
  beforeEach(() => {
    existsSyncMock.mockReset()
    spawnMock.mockReset()
    connectMock.mockReset()
    mockSystemSshExists()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('spawns reverse tunnel options before the ssh destination terminator', () => {
    spawnMock.mockReturnValue(createFakeProcess())

    spawnSystemSshReverseTunnel(createTarget({ configHost: 'relay-alias' }), {
      remoteBindHost: '0.0.0.0',
      remotePort: 6768,
      localHost: '127.0.0.1',
      localPort: 6768,
      probeHost: '203.0.113.10'
    })

    expect(spawnMock).toHaveBeenCalledWith(
      SYSTEM_SSH_PATH,
      [
        '-o',
        'BatchMode=no',
        '-T',
        '-N',
        '-o',
        'ExitOnForwardFailure=yes',
        '-o',
        'ServerAliveInterval=30',
        '-o',
        'ServerAliveCountMax=3',
        '-R',
        '0.0.0.0:6768:127.0.0.1:6768',
        '--',
        'deploy@relay-alias'
      ],
      expect.objectContaining({ stdio: ['ignore', 'ignore', 'pipe'] })
    )
  })

  it('resolves startup when the public endpoint probe connects', async () => {
    vi.useFakeTimers()
    const child = createFakeProcess()
    const socket = createFakeSocket()
    connectMock.mockReturnValue(socket)

    const pending = waitForSystemSshReverseTunnelStartup(child as never, '203.0.113.10', 6768)
    await vi.advanceTimersByTimeAsync(SYSTEM_SSH_REVERSE_TUNNEL_ENDPOINT_PROBE_INTERVAL_MS)
    socket.emit('connect')

    await expect(pending).resolves.toBeUndefined()
    expect(connectMock).toHaveBeenCalledWith({ host: '203.0.113.10', port: 6768 })
    expect(socket.destroy).toHaveBeenCalled()
  })

  it('rejects startup when ssh exits early with stderr', async () => {
    vi.useFakeTimers()
    const child = createFakeProcess()
    connectMock.mockReturnValue(createFakeSocket())

    const pending = waitForSystemSshReverseTunnelStartup(child as never, '203.0.113.10', 6768)
    child.stderr.emit('data', Buffer.from('remote port forwarding failed\\n'))
    child.emit('exit', 255)

    await expect(pending).rejects.toThrow('remote port forwarding failed')
  })

  it('resolves startup after the grace period when the endpoint probe keeps failing', async () => {
    vi.useFakeTimers()
    const child = createFakeProcess()
    const sockets: FakeSocket[] = []
    connectMock.mockImplementation(() => {
      const socket = createFakeSocket()
      sockets.push(socket)
      return socket
    })

    const pending = waitForSystemSshReverseTunnelStartup(child as never, '203.0.113.10', 6768)
    await vi.advanceTimersByTimeAsync(SYSTEM_SSH_REVERSE_TUNNEL_ENDPOINT_PROBE_INTERVAL_MS)
    sockets[0]?.emit('error', new Error('unreachable'))
    await vi.advanceTimersByTimeAsync(SYSTEM_SSH_REVERSE_TUNNEL_STARTUP_GRACE_MS)

    await expect(pending).resolves.toBeUndefined()
    expect(connectMock).toHaveBeenCalled()
  })

  it('does not wait for exit when stopping an already exited process', async () => {
    const child = createFakeProcess()
    child.exitCode = 255

    await expect(waitForSystemSshReverseTunnelStop(child as never)).resolves.toBeUndefined()
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('escalates stop from SIGTERM to SIGKILL after the timeout', async () => {
    vi.useFakeTimers()
    const child = createFakeProcess()

    const pending = waitForSystemSshReverseTunnelStop(child as never)
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    await vi.advanceTimersByTimeAsync(SYSTEM_SSH_REVERSE_TUNNEL_STOP_TIMEOUT_MS)
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    child.emit('exit', 0)

    await expect(pending).resolves.toBeUndefined()
  })
})
