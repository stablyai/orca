import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { existsSyncMock, spawnMock, connectMock, createServerMock, treeKillMock, admissionMock } =
  vi.hoisted(() => ({
    existsSyncMock: vi.fn(),
    spawnMock: vi.fn(),
    connectMock: vi.fn(),
    createServerMock: vi.fn(),
    treeKillMock: vi.fn(),
    admissionMock: vi.fn()
  }))

vi.mock('./system-ssh-loopback-route-admission', () => ({
  admitSystemSshLoopbackRoute: admissionMock
}))

vi.mock('@orca/process-host/process-tree-termination', async (importOriginal) => {
  const actual: Record<string, unknown> = await importOriginal()
  return { ...actual, signalProcessTree: treeKillMock }
})

vi.mock('./system-ssh-orphaned-forward', () => ({
  stopOrphanedOrcaSshForward: vi.fn().mockResolvedValue(false)
}))

vi.mock('fs', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, existsSync: existsSyncMock }
})

vi.mock('child_process', () => ({ spawn: spawnMock }))

vi.mock('net', () => ({ connect: connectMock, createServer: createServerMock }))

import type { SshTarget } from '../../../../shared/ssh-types'

import '../system-ssh-args'
import './system-ssh-forward-process'
import { startSystemSshLoopbackRoute } from './system-ssh-loopback-route'

const SYSTEM_SSH_PATH =
  process.platform === 'win32' ? 'C:\\Windows\\System32\\OpenSSH\\ssh.exe' : '/usr/bin/ssh'
const FREE_PORT = 49811

function createTarget(overrides?: Partial<SshTarget>): SshTarget {
  return {
    id: 'target-1',
    label: 'Dev box',
    host: 'devbox',
    configHost: 'devbox',
    port: 22,
    username: '',
    source: 'ssh-config',
    systemSshProxyConnectionReuse: true,
    ...overrides
  }
}

type FakeProcess = EventEmitter & {
  pid: number | undefined
  stdin: PassThrough
  stdout: PassThrough
  stderr: PassThrough
  kill: ReturnType<typeof vi.fn>
  exitCode: number | null
  signalCode: NodeJS.Signals | null
}

function createFakeProcess(): FakeProcess {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fields are assigned on the next lines, before the process is returned.
  const proc = new EventEmitter() as FakeProcess
  proc.pid = 4242
  proc.stdin = new PassThrough()
  proc.stdout = new PassThrough()
  proc.stderr = new PassThrough()
  proc.kill = vi.fn().mockReturnValue(true)
  proc.exitCode = null
  proc.signalCode = null
  return proc
}

function createFakeServer() {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fields are assigned on the next lines, before the server is returned.
  const server = new EventEmitter() as EventEmitter & {
    listen: ReturnType<typeof vi.fn>
    close: ReturnType<typeof vi.fn>
    address: ReturnType<typeof vi.fn>
  }
  server.listen = vi.fn().mockImplementation(() => {
    queueMicrotask(() => server.emit('listening'))
    return server
  })
  server.address = vi.fn(() => ({ address: '127.0.0.1', port: FREE_PORT }))
  server.close = vi.fn().mockImplementation((cb?: () => void) => cb?.())
  return server
}

function createListeningSocket(): EventEmitter {
  const socket = Object.assign(new EventEmitter(), { setTimeout: vi.fn(), destroy: vi.fn() })
  queueMicrotask(() => socket.emit('connect'))
  return socket
}

describe('startSystemSshLoopbackRoute', () => {
  beforeEach(() => {
    existsSyncMock.mockReset().mockImplementation((p: string) => p === SYSTEM_SSH_PATH)
    spawnMock.mockReset()
    connectMock.mockReset().mockImplementation(createListeningSocket)
    createServerMock.mockReset().mockImplementation(createFakeServer)
    treeKillMock.mockReset().mockResolvedValue(true)
    admissionMock
      .mockReset()
      .mockResolvedValue({ admitted: true, sshdPort: 22, hostKeyAlias: 'devbox' })
  })

  it('gives up without a probe when the forward exits before listening', async () => {
    const forward = createFakeProcess()
    spawnMock.mockReturnValueOnce(forward)
    connectMock.mockImplementation(() => {
      const socket = Object.assign(new EventEmitter(), { setTimeout: vi.fn(), destroy: vi.fn() })
      queueMicrotask(() => socket.emit('error', new Error('ECONNREFUSED')))
      return socket
    })

    const pending = startSystemSshLoopbackRoute(createTarget(), {}, 'linux')
    setImmediate(() => {
      forward.stderr.write('kex_exchange_identification: Connection closed by remote host\n')
      forward.emit('exit', 255)
    })

    await expect(pending).rejects.toThrow('Connection closed by remote host')
    expect(spawnMock).toHaveBeenCalledTimes(1)
  })
  it('cancels listener polling and closes its socket without waiting for child exit', async () => {
    vi.useFakeTimers()
    try {
      const forward = createFakeProcess()
      const socket = Object.assign(new EventEmitter(), { setTimeout: vi.fn(), destroy: vi.fn() })
      spawnMock.mockReturnValueOnce(forward)
      connectMock.mockReturnValue(socket)
      const controller = new AbortController()
      const pending = startSystemSshLoopbackRoute(createTarget(), {}, 'linux', controller.signal)
      const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
      await vi.advanceTimersByTimeAsync(50)
      expect(connectMock).toHaveBeenCalledTimes(1)
      controller.abort()
      await rejected
      expect(forward.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM')
      expect(socket.destroy).toHaveBeenCalledTimes(1)
      expect(socket.eventNames()).toEqual([])
      expect(forward.listenerCount('error')).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(connectMock).toHaveBeenCalledTimes(1)
      expect(spawnMock).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels the login probe and forward without waiting for probe timeout', async () => {
    vi.useFakeTimers()
    try {
      const forward = createFakeProcess()
      const probe = createFakeProcess()
      spawnMock.mockReturnValueOnce(forward).mockReturnValueOnce(probe)
      const controller = new AbortController()
      const pending = startSystemSshLoopbackRoute(createTarget(), {}, 'linux', controller.signal)
      const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
      await vi.advanceTimersByTimeAsync(50)
      expect(spawnMock).toHaveBeenCalledTimes(2)
      controller.abort()
      await rejected
      expect(forward.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM')
      expect(probe.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM')
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not spawn a forward if cancelled during port reservation', async () => {
    const server = createFakeServer()
    createServerMock.mockReturnValueOnce(server)
    server.listen.mockImplementationOnce(() => server)
    const controller = new AbortController()
    const pending = startSystemSshLoopbackRoute(createTarget(), {}, 'linux', controller.signal)
    controller.abort()
    server.emit('listening')
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('closes a live login probe when its output stream errors', async () => {
    vi.useFakeTimers()
    try {
      const forward = createFakeProcess()
      const probe = createFakeProcess()
      spawnMock.mockReturnValueOnce(forward).mockReturnValueOnce(probe)
      const pending = startSystemSshLoopbackRoute(createTarget(), {}, 'linux')
      const rejected = expect(pending).rejects.toThrow('probe output failed')
      await vi.advanceTimersByTimeAsync(50)
      probe.stdout.emit('error', new Error('probe output failed'))
      await rejected
      expect(probe.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM')
      expect(forward.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM')
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
