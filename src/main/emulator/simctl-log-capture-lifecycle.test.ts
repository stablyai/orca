import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

const spawnMock = vi.hoisted(() => vi.fn())
vi.mock('../../shared/child-process/run-process', () => ({ spawnProcess: spawnMock }))

import { captureSimulatorLog } from './simctl-log-capture'

function startCapture() {
  const child = Object.assign(new EventEmitter(), {
    pid: 123 as number | undefined,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    killed: false,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn().mockReturnValue(true)
  })
  spawnMock.mockReturnValue(child)
  const result = captureSimulatorLog('device-1').catch((error: Error) => error)
  return { child, result }
}

function expectClean(child: ReturnType<typeof startCapture>['child']): void {
  expect(vi.getTimerCount()).toBe(0)
  expect(child.stdout.listenerCount('data')).toBe(0)
  expect(child.stderr.listenerCount('data')).toBe(0)
  expect(child.listenerCount('close')).toBe(0)
  expect(child.listenerCount('exit')).toBe(0)
  const emitters: EventEmitter[] = [child, child.stdout, child.stderr]
  for (const emitter of emitters) {
    expect(emitter.listenerCount('error')).toBe(1)
    expect(() => emitter.emit('error', new Error('late'))).not.toThrow()
  }
}

describe('simulator log capture failure lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    spawnMock.mockReset()
  })
  afterEach(() => vi.useRealTimers())

  it('settles a silent timeout after TERM then KILL and releases listeners', async () => {
    const { child, result } = startCapture()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(child.kill.mock.calls).toEqual([['SIGTERM']])
    child.killed = true
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(await result).toMatchObject({
      message: expect.stringContaining('timed out after 20000ms')
    })
    expect(child.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']])
    expect(child.stdout.destroyed).toBe(true)
    expect(child.stderr.destroyed).toBe(true)
    expectClean(child)
    child.emit('close', 0, null)
    child.emit('close', 1, null)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(child.kill).toHaveBeenCalledTimes(2)
  })

  it('keeps timeout authoritative when TERM synchronously closes successfully', async () => {
    const { child, result } = startCapture()
    child.kill.mockImplementation(() => child.emit('close', 0, null))
    await vi.advanceTimersByTimeAsync(20_000)
    expect(await result).toMatchObject({ message: expect.stringContaining('timed out') })
    expectClean(child)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(child.kill.mock.calls).toEqual([['SIGTERM']])
  })

  it.each(['stdout', 'stderr', 'child'] as const)(
    'maps %s errors of every code and bounds cleanup without close',
    async (source) => {
      for (const code of ['EIO', 'EPIPE', 'EACCES']) {
        const { child, result } = startCapture()
        const emitter: EventEmitter = source === 'child' ? child : child[source]
        expect(() => emitter.emit('error', Object.assign(new Error(code), { code }))).not.toThrow()
        expect(child.stdout.listenerCount('data')).toBe(0)
        child.stderr.write('diagnostic during grace')
        await vi.advanceTimersByTimeAsync(2_000)
        expect(await result).toMatchObject({
          code: 'emulator_error',
          message: `${code}\ndiagnostic during grace`
        })
        expect(child.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']])
        expectClean(child)
      }
    }
  )

  it.each(['timeout', 'stream'] as const)('preserves the first %s failure', async (first) => {
    const { child, result } = startCapture()
    if (first === 'timeout') {
      await vi.advanceTimersByTimeAsync(20_000)
    }
    child.stdout.emit('error', new Error('first stream failure'))
    child.stderr.emit('error', new Error('second stream failure'))
    child.emit('error', new Error('child failure'))
    child.emit('close', 0, null)
    expect(await result).toMatchObject({
      message: expect.stringContaining(first === 'timeout' ? 'timed out' : 'first stream failure')
    })
    expectClean(child)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(child.kill).toHaveBeenCalledTimes(1)
  })

  it.each(['false', 'throw', 'error', 'close'] as const)(
    'settles when signalling returns or emits %s',
    async (behavior) => {
      const { child, result } = startCapture()
      child.kill.mockImplementation((signal) => {
        if (behavior === 'throw') {
          throw new Error('kill threw')
        }
        if (behavior === 'error') {
          child.emit('error', new Error('kill error'))
        }
        if (behavior === 'close' && signal === 'SIGKILL') {
          child.emit('close', 0, null)
        }
        return false
      })
      child.stderr.emit('error', new Error('original failure'))
      await vi.advanceTimersByTimeAsync(2_000)
      expect(await result).toMatchObject({ message: 'original failure' })
      expect(child.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']])
      expectClean(child)
    }
  )

  it.each(['exit', 'exitCode', 'signalCode'] as const)(
    'does not signal an exited root observed through %s without close',
    async (observation) => {
      const { child, result } = startCapture()
      if (observation === 'exit') {
        child.emit('exit', 0, null)
      }
      if (observation === 'exitCode') {
        child.exitCode = 0
      }
      if (observation === 'signalCode') {
        child.signalCode = 'SIGTERM'
      }
      await vi.advanceTimersByTimeAsync(22_000)
      expect(await result).toBeInstanceOf(Error)
      expect(child.kill).not.toHaveBeenCalled()
      expectClean(child)
    }
  )

  it('does not escalate after exit during grace when close never arrives', async () => {
    const { child, result } = startCapture()
    child.stdout.emit('error', new Error('broken pipe'))
    child.emit('exit', null, 'SIGTERM')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(await result).toMatchObject({ message: 'broken pipe' })
    expect(child.kill.mock.calls).toEqual([['SIGTERM']])
    expectClean(child)
  })

  it('maps a proven ENOENT spawn failure immediately without signalling', async () => {
    const { child, result } = startCapture()
    child.pid = undefined
    child.emit('error', Object.assign(new Error('not found'), { code: 'ENOENT' }))
    expect(await result).toMatchObject({ code: 'emulator_simctl_unavailable' })
    expect(child.kill).not.toHaveBeenCalled()
    expectClean(child)
  })

  it('cleans up an existing child even when its error code is ENOENT', async () => {
    const { child, result } = startCapture()
    child.emit('error', Object.assign(new Error('not found'), { code: 'ENOENT' }))
    await vi.advanceTimersByTimeAsync(2_000)
    expect(await result).toMatchObject({ code: 'emulator_simctl_unavailable' })
    expect(child.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']])
    expectClean(child)
  })

  it('maps nonzero close using only the bounded stderr tail', async () => {
    const { child, result } = startCapture()
    child.stderr.write(`not a developer tool${'x'.repeat(64 * 1024)}`)
    child.emit('close', 1, 'SIGTERM')
    expect(await result).toMatchObject({
      code: 'emulator_error',
      message: `xcrun simctl log show exited with code 1 (SIGTERM)\n${'x'.repeat(64 * 1024)}`
    })
    expect(child.kill).not.toHaveBeenCalled()
    expectClean(child)
  })

  it('detaches successful capture data handlers so later data cannot mutate results', async () => {
    const { child, result } = startCapture()
    child.stdout.write('{"eventMessage":"first"}\n')
    child.emit('close', 0, null)
    const entries = await result
    child.stdout.emit('data', '{"eventMessage":"late"}\n')
    child.emit('close', 1, null)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(entries).toEqual([{ message: 'first' }])
    expect(child.kill).not.toHaveBeenCalled()
    expectClean(child)
  })
})
