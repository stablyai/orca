import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  killWithDescendantSweep,
  terminateDescendantSnapshot,
  type DescendantSnapshot,
  type ProcessTableCapture,
  type ProcessTableRow
} from './pty-descendant-termination'
import { readProcessTableWithRetries } from './pty-process-table-deadline'

const target: ProcessTableRow = {
  pid: 20,
  ppid: 10,
  pgid: 20,
  startedAt: 'Mon Jul 13 12:54:47 2026'
}
const root = { ...target, pid: 10, ppid: 1, pgid: 10 }
const capturedAtMs = Date.parse('Tue Jul 14 12:00:00 2026')
const snapshot: DescendantSnapshot = { rootPgid: 10, descendants: [target], capturedAtMs }
const capture = (rows = [target]): ProcessTableCapture => ({ rows, capturedAtMs })

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('bounded descendant identity read retries', () => {
  it.each(['reject', 'throw'] as const)(
    'retains the root after a transient %s',
    async (failure) => {
      const events: string[] = []
      const readTable = vi
        .fn()
        .mockResolvedValueOnce(capture([root, target]))
        .mockImplementationOnce(() => {
          if (failure === 'throw') {
            throw new Error('busy')
          }
          return Promise.reject(new Error('busy'))
        })
        .mockResolvedValue(capture())
      const pending = killWithDescendantSweep(10, () => events.push('root'), {
        platform: 'linux',
        readTable,
        sendSignal: (_pid, signal) => events.push(signal),
        graceMs: 100,
        awaitEscalation: true
      })
      await vi.advanceTimersByTimeAsync(49)
      expect(events).toEqual([])
      await vi.advanceTimersByTimeAsync(1)
      expect(events).toEqual(['SIGTERM', 'root'])
      await vi.advanceTimersByTimeAsync(100)
      await pending
      expect(events).toEqual(['SIGTERM', 'root', 'SIGKILL'])
      expect(readTable.mock.calls).toEqual([[1_000], [1_000], [950], [1_000]])
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it.each([
    [{ ...target, startedAt: 'Tue Jul 14 12:00:00 2026' }],
    [{ ...target, pgid: 99 }],
    [target, target],
    []
  ])('does not refresh original identities after an unreadable table', async (...rows) => {
    const readTable = vi
      .fn()
      .mockRejectedValueOnce(new Error('busy'))
      .mockResolvedValue(capture(rows))
    const sendSignal = vi.fn()
    const pending = terminateDescendantSnapshot(snapshot, { readTable, sendSignal })
    await vi.advanceTimersByTimeAsync(50)
    await pending
    expect(sendSignal).not.toHaveBeenCalled()
    expect(readTable).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not retry or signal after root ownership is lost in the backoff', async () => {
    let owned = true
    const readTable = vi
      .fn()
      .mockResolvedValueOnce(capture([root, target]))
      .mockRejectedValueOnce(new Error('busy'))
      .mockResolvedValue(capture())
    const killRoot = vi.fn()
    const sendSignal = vi.fn()
    const pending = killWithDescendantSweep(10, killRoot, {
      platform: 'linux',
      readTable,
      sendSignal,
      ownsRoot: () => owned
    })
    await vi.advanceTimersByTimeAsync(25)
    owned = false
    await vi.advanceTimersByTimeAsync(25)
    await pending
    expect(readTable).toHaveBeenCalledTimes(2)
    expect(sendSignal).not.toHaveBeenCalled()
    expect(killRoot).toHaveBeenCalledOnce()
  })

  it('can escalate after both the initial read and final read take 950ms', async () => {
    const readTable = vi.fn(
      () =>
        new Promise<ProcessTableCapture>((resolve) => {
          setTimeout(() => resolve(capture()), 950)
        })
    )
    const sendSignal = vi.fn()
    const pending = terminateDescendantSnapshot(snapshot, {
      readTable,
      sendSignal,
      awaitEscalation: true
    })
    await vi.advanceTimersByTimeAsync(950)
    expect(sendSignal.mock.calls).toEqual([[20, 'SIGTERM']])
    await vi.advanceTimersByTimeAsync(2_950)
    await pending
    expect(readTable.mock.calls).toEqual([[1_000], [1_000]])
    expect(sendSignal.mock.calls).toEqual([
      [20, 'SIGTERM'],
      [20, 'SIGKILL']
    ])
  })

  it('retries a transient escalation failure within its separate window', async () => {
    const readTable = vi
      .fn()
      .mockResolvedValueOnce(capture())
      .mockRejectedValueOnce(new Error('busy'))
      .mockResolvedValue(capture())
    const sendSignal = vi.fn()
    const pending = terminateDescendantSnapshot(snapshot, { readTable, sendSignal, graceMs: 100 })
    await vi.advanceTimersByTimeAsync(149)
    expect(sendSignal.mock.calls).toEqual([[20, 'SIGTERM']])
    await vi.advanceTimersByTimeAsync(1)
    await pending
    expect(sendSignal.mock.calls).toEqual([
      [20, 'SIGTERM'],
      [20, 'SIGKILL']
    ])
    expect(readTable.mock.calls).toEqual([[1_000], [1_000], [950]])
  })

  it('bounds repeated failures without busy-looping', async () => {
    const readTable = vi.fn().mockRejectedValue(new Error('unavailable'))
    const pending = readProcessTableWithRetries(readTable, 125, true)
    await vi.advanceTimersByTimeAsync(125)
    await expect(pending).resolves.toBeNull()
    expect(readTable.mock.calls).toEqual([[125], [75], [25]])
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([false, true])(
    'keeps retry timers ref state aligned with keepAlive=%s',
    async (keepAlive) => {
      const timers = vi.spyOn(globalThis, 'setTimeout')
      try {
        const pending = readProcessTableWithRetries(
          vi.fn().mockRejectedValue(new Error('busy')),
          60,
          keepAlive
        )
        await vi.advanceTimersByTimeAsync(0)
        const backoff = timers.mock.results.at(-1)?.value
        expect(backoff.hasRef()).toBe(keepAlive)
        await vi.advanceTimersByTimeAsync(60)
        await pending
        expect(vi.getTimerCount()).toBe(0)
      } finally {
        timers.mockRestore()
      }
    }
  )
})
