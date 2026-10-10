import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { spawnMock, connectMock, createServerMock, waitForStopMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  connectMock: vi.fn(),
  createServerMock: vi.fn(),
  waitForStopMock: vi.fn(async () => {})
}))

vi.mock('node:child_process', () => ({ spawn: spawnMock }))
vi.mock('node:net', () => ({ connect: connectMock, createServer: createServerMock }))
vi.mock('./ssh-system-fallback', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, findSystemSsh: () => '/usr/bin/ssh' }
})
vi.mock('./system-ssh-forward-process', () => ({
  waitForSystemSshForwardStop: waitForStopMock
}))

import { startSystemSshDynamicForwardProcess } from './system-ssh-dynamic-forward-process'

function fakeServer() {
  const server = new EventEmitter() as EventEmitter & {
    listen: ReturnType<typeof vi.fn>
    address: ReturnType<typeof vi.fn>
    close: ReturnType<typeof vi.fn>
  }
  server.listen = vi.fn((_port, _host, callback: () => void) => {
    queueMicrotask(callback)
    return server
  })
  server.address = vi.fn(() => ({ address: '127.0.0.1', family: 'IPv4', port: 45678 }))
  server.close = vi.fn((callback?: (error?: Error) => void) => callback?.())
  return server
}

function fakeProcess() {
  const process = new EventEmitter() as EventEmitter & {
    stderr: EventEmitter
    exitCode: number | null
    signalCode: NodeJS.Signals | null
    kill: ReturnType<typeof vi.fn>
  }
  process.stderr = new EventEmitter()
  process.exitCode = null
  process.signalCode = null
  process.kill = vi.fn(() => true)
  return process
}

function fakeProbe(connects: boolean) {
  const socket = new EventEmitter() as EventEmitter & {
    destroy: ReturnType<typeof vi.fn>
    removeAllListeners: EventEmitter['removeAllListeners']
  }
  socket.destroy = vi.fn()
  if (connects) {
    queueMicrotask(() => socket.emit('connect'))
  }
  return socket
}

const target = {
  id: 'target-a',
  label: 'Target A',
  host: 'ssh.example.com',
  port: 2222,
  username: 'orca',
  identityFile: '/tmp/id_ed25519'
}

describe('system SSH dynamic forward process', () => {
  beforeEach(() => {
    spawnMock.mockReset().mockImplementation(fakeProcess)
    connectMock.mockReset().mockImplementation(() => fakeProbe(true))
    createServerMock.mockReset().mockImplementation(fakeServer)
    waitForStopMock.mockClear()
  })

  afterEach(() => vi.useRealTimers())

  it('starts one non-interactive dynamic forward before the destination', async () => {
    const forward = await startSystemSshDynamicForwardProcess(target)
    const args = spawnMock.mock.calls[0]![1] as string[]

    expect(args).toEqual(
      expect.arrayContaining([
        '-o',
        'BatchMode=yes',
        '-S',
        'none',
        '-p',
        '2222',
        '-i',
        '/tmp/id_ed25519',
        '-D',
        '127.0.0.1:45678'
      ])
    )
    expect(args.indexOf('-D')).toBeLessThan(args.indexOf('--'))
    expect(args[args.indexOf('--') + 1]).toBe('orca@ssh.example.com')
    expect(spawnMock).toHaveBeenCalledOnce()

    await forward.close()
    expect(waitForStopMock).toHaveBeenCalledOnce()
  })

  it('kills startup immediately when SSH authority is invalidated', async () => {
    connectMock.mockImplementation(() => fakeProbe(false))
    const controller = new AbortController()
    const starting = startSystemSshDynamicForwardProcess(target, undefined, controller.signal)
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce())
    const process = spawnMock.mock.results[0]!.value as ReturnType<typeof fakeProcess>
    const probe = connectMock.mock.results[0]!.value as ReturnType<typeof fakeProbe>

    controller.abort()

    await expect(starting).rejects.toThrow('system_ssh_dynamic_forward_aborted')
    expect(process.kill).toHaveBeenCalledWith('SIGTERM')
    expect(probe.destroy).toHaveBeenCalledOnce()
    expect(waitForStopMock).toHaveBeenCalledOnce()
  })
})
