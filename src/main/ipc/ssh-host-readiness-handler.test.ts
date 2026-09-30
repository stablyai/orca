import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshReadinessReport } from '../../shared/ssh-types'
import { SSH_READINESS_PROBE_SCRIPT } from '../ssh/ssh-host-readiness'
import { registerSshHostReadinessHandler } from './ssh-host-readiness-handler'

const { handleMock, removeHandlerMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  removeHandlerMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: handleMock,
    removeHandler: removeHandlerMock
  }
}))

type ReadinessHandler = (event: unknown, args: { targetId: string }) => Promise<SshReadinessReport>

function createMockChannel(): EventEmitter & { stderr: EventEmitter } {
  return Object.assign(new EventEmitter(), {
    stderr: new EventEmitter()
  })
}

function registerWithExec(exec: ReturnType<typeof vi.fn>): void {
  const getConnectionManager = () => ({ getConnection: () => ({ exec }) })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler only calls getConnection(id).exec, which this stub provides.
  registerSshHostReadinessHandler(getConnectionManager as never)
}

describe('registerSshHostReadinessHandler', () => {
  let handler: ReadinessHandler

  beforeEach(() => {
    handleMock.mockReset()
    removeHandlerMock.mockReset()
    handleMock.mockImplementation((_channel: string, registeredHandler: ReadinessHandler) => {
      handler = registeredHandler
    })
  })

  it('removes any previous handler before registering', () => {
    registerWithExec(vi.fn())

    expect(removeHandlerMock).toHaveBeenCalledWith('ssh:probeReadiness')
    expect(handleMock).toHaveBeenCalledWith('ssh:probeReadiness', expect.any(Function))
  })

  it('rejects when the SSH connection manager is not initialized', async () => {
    registerSshHostReadinessHandler(() => null)

    await expect(handler(null, { targetId: 'ssh-1' })).rejects.toThrow(
      'SSH connection manager not initialized'
    )
  })

  it('rejects when the target has no connection', async () => {
    const getConnectionManager = () => ({ getConnection: () => null })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler only calls getConnection(id).exec, which this stub provides.
    registerSshHostReadinessHandler(getConnectionManager as never)

    await expect(handler(null, { targetId: 'ssh-9' })).rejects.toThrow(
      'SSH connection "ssh-9" not found'
    )
  })

  it('returns the parsed report of the probe stdout', async () => {
    const channel = createMockChannel()
    const exec = vi.fn().mockResolvedValue(channel)
    registerWithExec(exec)

    const resultPromise = handler(null, { targetId: 'ssh-1' })
    await Promise.resolve()
    channel.emit('data', Buffer.from('node\tok\tv20.11.1\ntoolchain\tmiss\tmissing g++\n'))
    channel.emit('exit', 0)
    channel.emit('close')

    const report = await resultPromise
    expect(report.checks.find((check) => check.key === 'node')).toEqual({
      key: 'node',
      state: 'ok',
      detail: 'v20.11.1'
    })
    expect(report.checks.find((check) => check.key === 'toolchain')).toEqual({
      key: 'toolchain',
      state: 'miss',
      detail: 'missing g++'
    })
    // A check the probe never reported must read as unknown, not as a pass.
    expect(report.checks.find((check) => check.key === 'github')).toEqual({
      key: 'github',
      state: 'unknown',
      detail: ''
    })
    expect(report.probedAt).toBeGreaterThan(0)
    // The multiline probe rides conn.exec's default POSIX wrapping, so no options are passed.
    expect(exec).toHaveBeenCalledWith(SSH_READINESS_PROBE_SCRIPT)
    expect(channel.listenerCount('data')).toBe(0)
    expect(channel.listenerCount('exit')).toBe(0)
    expect(channel.listenerCount('close')).toBe(0)
    expect(channel.listenerCount('error')).toBe(0)
    expect(channel.stderr.listenerCount('data')).toBe(0)
    expect(channel.stderr.listenerCount('error')).toBe(0)
  })

  it('returns a report for a non-zero exit instead of throwing', async () => {
    const channel = createMockChannel()
    const exec = vi.fn().mockResolvedValue(channel)
    registerWithExec(exec)

    const resultPromise = handler(null, { targetId: 'ssh-1' })
    await Promise.resolve()
    channel.emit('data', Buffer.from('node\tmiss\t\n'))
    channel.stderr.emit('data', Buffer.from('sh: 1: cut: not found'))
    channel.emit('exit', 2)
    channel.emit('close')

    const report = await resultPromise
    expect(report.checks.find((check) => check.key === 'node')).toEqual({
      key: 'node',
      state: 'miss',
      detail: ''
    })
    expect(report.checks).toHaveLength(7)
  })

  it('returns an all-unknown report when the host has no POSIX sh to run the probe', async () => {
    const channel = createMockChannel()
    const exec = vi.fn().mockResolvedValue(channel)
    registerWithExec(exec)

    const resultPromise = handler(null, { targetId: 'ssh-1' })
    await Promise.resolve()
    channel.stderr.emit('data', Buffer.from("'exec' is not recognized as an internal command"))
    channel.emit('exit', 1)
    channel.emit('close')

    const report = await resultPromise
    expect(report.checks.every((check) => check.state === 'unknown')).toBe(true)
  })

  it('keeps the head of a flooding stdout rather than growing the buffer', async () => {
    const channel = createMockChannel()
    const exec = vi.fn().mockResolvedValue(channel)
    registerWithExec(exec)

    const resultPromise = handler(null, { targetId: 'ssh-1' })
    await Promise.resolve()
    // 64 KiB of junk, then a valid line past the cap: the report is built from the head, so the tail is cut.
    channel.emit('data', Buffer.from('x\n'.repeat(40 * 1024)))
    channel.emit('data', Buffer.from('node\tok\tv20.11.1\n'))
    channel.emit('exit', 0)
    channel.emit('close')

    const report = await resultPromise
    expect(report.checks.find((check) => check.key === 'node')).toEqual({
      key: 'node',
      state: 'unknown',
      detail: ''
    })
  })

  it('rejects and detaches listeners when the probe channel errors', async () => {
    const channel = createMockChannel()
    const exec = vi.fn().mockResolvedValue(channel)
    registerWithExec(exec)

    const resultPromise = handler(null, { targetId: 'ssh-1' })
    await Promise.resolve()
    channel.emit('error', new Error('remote disconnected'))

    await expect(resultPromise).rejects.toThrow('remote disconnected')
    expect(channel.listenerCount('data')).toBe(0)
    expect(channel.listenerCount('exit')).toBe(0)
    expect(channel.listenerCount('close')).toBe(0)
    expect(channel.listenerCount('error')).toBe(0)
    expect(channel.stderr.listenerCount('data')).toBe(0)
    expect(channel.stderr.listenerCount('error')).toBe(0)
  })

  it('times out probe channels that never close', async () => {
    vi.useFakeTimers()
    try {
      const channel = createMockChannel()
      const exec = vi.fn().mockResolvedValue(channel)
      registerWithExec(exec)

      const resultPromise = handler(null, { targetId: 'ssh-1' })
      let settled = false
      void resultPromise.then(
        () => {
          settled = true
        },
        () => {
          settled = true
        }
      )

      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(20_000)

      expect(settled).toBe(true)
      await expect(resultPromise).rejects.toThrow('SSH host readiness probe timed out')
      expect(channel.listenerCount('data')).toBe(0)
      expect(channel.listenerCount('exit')).toBe(0)
      expect(channel.listenerCount('close')).toBe(0)
      expect(channel.listenerCount('error')).toBe(0)
      expect(channel.stderr.listenerCount('data')).toBe(0)
      expect(channel.stderr.listenerCount('error')).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
