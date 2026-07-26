import { EventEmitter } from 'node:events'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

const { existsSyncMock, spawnMock, connectMock, createServerMock } = vi.hoisted(() => ({
  existsSyncMock: vi.fn(),
  spawnMock: vi.fn(),
  connectMock: vi.fn(),
  createServerMock: vi.fn()
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
  SYSTEM_SSH_FORWARD_LISTENER_PROBE_INTERVAL_MS,
  SYSTEM_SSH_FORWARD_STARTUP_GRACE_MS,
  spawnSystemSshPortForward,
  startSystemSshPortForwardProcess,
  waitForSystemSshForwardStartup,
  waitForSystemSshForwardStop
} from './system-ssh-forward-process'
import type { SshTarget } from '../../shared/ssh-types'
import { SYSTEM_SSH_OUTPUT_TAIL_MAX_BYTES } from './system-ssh-output-tail'

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

function expectNoOrcaControlMasterArgs(args: string[]): void {
  expect(args).not.toContain('ControlMaster=auto')
  expect(args.some((arg) => arg.startsWith('ControlPath='))).toBe(false)
  expect(args).not.toContain('ControlPersist=300')
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
  const server = new EventEmitter() as EventEmitter & {
    listen: ReturnType<typeof vi.fn>
    close: ReturnType<typeof vi.fn>
  }
  server.listen = vi.fn().mockImplementation(() => {
    queueMicrotask(() => server.emit('listening'))
    return server
  })
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
    mockSystemSshExists()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('spawns port forwards before the ssh destination terminator', () => {
    spawnMock.mockReturnValue(createFakeProcess())

    spawnSystemSshPortForward(createTarget({ configHost: 'fdpass-host' }), 5173, '127.0.0.1', 3000)

    const args = spawnMock.mock.calls[0][1] as string[]
    const terminatorIdx = args.indexOf('--')
    const forwardFlagIdx = args.indexOf('-N')
    const localForwardIdx = args.indexOf('-L')
    const exitOnForwardFailureIdx = args.indexOf('ExitOnForwardFailure=yes')
    const standaloneControlIdx = args.indexOf('-S')

    expect(terminatorIdx).toBeGreaterThan(-1)
    expect(forwardFlagIdx).toBeGreaterThan(-1)
    expect(localForwardIdx).toBeGreaterThan(-1)
    expect(exitOnForwardFailureIdx).toBeGreaterThan(-1)
    // Why: -N and -L must appear before -- or OpenSSH treats them as remote command args.
    expect(forwardFlagIdx).toBeLessThan(terminatorIdx)
    expect(localForwardIdx).toBeLessThan(terminatorIdx)
    expect(args[exitOnForwardFailureIdx - 1]).toBe('-o')
    expect(exitOnForwardFailureIdx).toBeLessThan(terminatorIdx)
    expect(standaloneControlIdx).toBe(-1)
    expectNoOrcaControlMasterArgs(args)
    expect(args).toContain('127.0.0.1:5173:127.0.0.1:3000')
    expect(args[terminatorIdx + 1]).toBe('deploy@fdpass-host')
    expect(spawnMock).toHaveBeenCalledWith(
      SYSTEM_SSH_PATH,
      expect.any(Array),
      expect.objectContaining({ stdio: ['ignore', 'ignore', 'pipe'] })
    )
  })

  it('suppresses Orca mux flags for port forwards without disabling ssh_config muxing', () => {
    spawnMock.mockReturnValue(createFakeProcess())

    spawnSystemSshPortForward(createTarget(), 5173, '127.0.0.1', 3000, {
      resolvedConfig: {
        hostname: 'example.com',
        port: 22,
        identityFile: [],
        forwardAgent: false,
        identitiesOnly: false,
        proxyUseFdpass: false,
        controlMaster: 'no',
        controlPersist: 'no'
      }
    })

    const args = spawnMock.mock.calls[0][1] as string[]
    expect(args.indexOf('-S')).toBe(-1)
    expectNoOrcaControlMasterArgs(args)
  })

  it('preserves user-configured muxing for port forwards', () => {
    spawnMock.mockReturnValue(createFakeProcess())

    spawnSystemSshPortForward(
      createTarget({ configHost: 'workbox', source: 'ssh-config' }),
      5173,
      '127.0.0.1',
      3000,
      {
        resolvedConfig: {
          hostname: 'workbox.internal',
          port: 22,
          identityFile: [],
          forwardAgent: false,
          identitiesOnly: false,
          proxyUseFdpass: false,
          controlMaster: 'auto',
          controlPath: '/Users/me/.ssh/cm/%r@%h:%p',
          controlPersist: '10m'
        }
      }
    )

    const args = spawnMock.mock.calls[0][1] as string[]
    expect(args.indexOf('-S')).toBe(-1)
    expectNoOrcaControlMasterArgs(args)
    expect(args).toContain('deploy@workbox')
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

  it('does not spawn ssh when the requested local forward port is already in use', async () => {
    const server = createFakeServer()
    server.listen.mockImplementation(() => {
      queueMicrotask(() => server.emit('error', new Error('EADDRINUSE')))
      return server
    })
    createServerMock.mockReturnValue(server)

    await expect(
      startSystemSshPortForwardProcess(createTarget(), 5173, '127.0.0.1', 3000)
    ).rejects.toThrow('Local port 127.0.0.1:5173 is not available')
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('spawns ssh after the requested local forward port preflight succeeds', async () => {
    const child = createFakeProcess()
    spawnMock.mockReturnValue(child)

    const forward = await startSystemSshPortForwardProcess(createTarget(), 5173, '127.0.0.1', 3000)

    expect(spawnMock).toHaveBeenCalled()
    expect(forward.process).toBe(child)
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

  it('keeps only a bounded stderr tail while waiting for forward startup', async () => {
    vi.useFakeTimers()
    const child = createFakeProcess()
    connectMock.mockReturnValue(createFakeSocket())

    const pending = waitForSystemSshForwardStartup(child as never, 3000)
    child.stderr.emit(
      'data',
      Buffer.from(`HEAD${'x'.repeat(SYSTEM_SSH_OUTPUT_TAIL_MAX_BYTES)}TAIL`)
    )
    child.emit('exit', 255)

    await expect(pending).rejects.toThrow('TAIL')
    await expect(pending).rejects.not.toThrow('HEAD')
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
