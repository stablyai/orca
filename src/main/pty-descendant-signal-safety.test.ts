import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  killWithDescendantSweep,
  terminateDescendantSnapshot,
  type DescendantSnapshot,
  type ProcessTableCapture,
  type ProcessTableRow
} from './pty-descendant-termination'

const CAPTURED_AT_MS = Date.parse('Tue Jul 14 12:00:00 2026')
const target: ProcessTableRow = {
  pid: 20,
  ppid: 10,
  pgid: 20,
  startedAt: 'Mon Jul 13 12:54:47 2026'
}
const root = { ...target, pid: 10, ppid: 1, pgid: 10 }

function snapshot(descendants = [target]): DescendantSnapshot {
  return {
    root: { pid: root.pid, startedAt: root.startedAt },
    rootPgid: root.pgid,
    descendants,
    capturedAtMs: CAPTURED_AT_MS,
    reDerivedPids: new Set(descendants.map((row) => row.pid))
  }
}

function capture(rows = [target]): ProcessTableCapture {
  return { rows, capturedAtMs: CAPTURED_AT_MS + 3_000 }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

const unsafeTables = [
  { name: 'absent PID', rows: [] },
  {
    name: 'reused PID with different start',
    rows: [{ ...target, startedAt: 'Tue Jul 14 09:00:00 2026' }]
  },
  { name: 'changed process group', rows: [{ ...target, pgid: 99 }] },
  { name: 'identical duplicate rows', rows: [target, target] },
  { name: 'three conflicting rows', rows: [target, { ...target, pgid: 99 }, target] }
]

describe('descendant identity revalidation', () => {
  it.each(unsafeTables)('skips SIGTERM and escalation for $name', async ({ rows }) => {
    const readTable = vi.fn().mockResolvedValue(capture(rows))
    const sendSignal = vi.fn()
    await terminateDescendantSnapshot(snapshot(), { readTable, sendSignal })
    expect(sendSignal).not.toHaveBeenCalled()
    expect(readTable).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(unsafeTables)('rechecks $name before SIGKILL', async ({ rows }) => {
    const readTable = vi.fn().mockResolvedValueOnce(capture()).mockResolvedValue(capture(rows))
    const sendSignal = vi.fn()
    const pending = terminateDescendantSnapshot(snapshot(), { readTable, sendSignal, graceMs: 100 })
    await vi.advanceTimersByTimeAsync(100)
    await pending
    expect(sendSignal.mock.calls).toEqual([[20, 'SIGTERM']])
    expect(readTable).toHaveBeenCalledTimes(2)
  })

  it.each(['not a timestamp', 'Tue Jul 14 12:00:00 2026', 'Tue Jul 14 12:00:01 2026'])(
    'rejects unverifiable start %s even after rollover and a re-derived walk',
    async (startedAt) => {
      const row = { ...target, startedAt }
      const sendSignal = vi.fn()
      await terminateDescendantSnapshot(snapshot([row]), {
        readTable: vi.fn().mockResolvedValue(capture([row])),
        sendSignal
      })
      expect(sendSignal).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it.each([0, -20, Number.NaN, Infinity])('never forwards invalid PID %s to kill', async (pid) => {
    const row = { ...target, pid }
    const sendSignal = vi.fn()
    await terminateDescendantSnapshot(snapshot([row]), {
      readTable: vi.fn().mockResolvedValue(capture([row])),
      sendSignal
    })
    expect(sendSignal).not.toHaveBeenCalled()
  })

  it.each([Number.NaN, Infinity])(
    'rejects unverifiable capture boundary %s',
    async (capturedAtMs) => {
      const sendSignal = vi.fn()
      await terminateDescendantSnapshot(
        { ...snapshot(), capturedAtMs },
        {
          readTable: vi.fn().mockResolvedValue(capture()),
          sendSignal
        }
      )
      expect(sendSignal).not.toHaveBeenCalled()
    }
  )

  it('rejects duplicate source PIDs while preserving valid unrelated targets', async () => {
    const other = { ...target, pid: 30, pgid: 30 }
    const sendSignal = vi.fn()
    const pending = terminateDescendantSnapshot(snapshot([target, target, other]), {
      readTable: vi.fn().mockResolvedValue(capture([target, other])),
      sendSignal,
      graceMs: 100
    })
    await vi.advanceTimersByTimeAsync(100)
    await pending
    expect(sendSignal.mock.calls).toEqual([
      [30, 'SIGTERM'],
      [30, 'SIGKILL']
    ])
  })

  it('uses each merged row original boundary for both signals', async () => {
    const retained = { ...target, startedAt: 'Tue Jul 14 12:00:00 2026' }
    const fresh = { ...target, pid: 30, startedAt: 'Tue Jul 14 12:00:01 2026' }
    const sendSignal = vi.fn()
    const pending = terminateDescendantSnapshot(
      {
        ...snapshot([retained, fresh]),
        capturedAtMs: CAPTURED_AT_MS + 2_100,
        capturedAtMsByPid: { '20': CAPTURED_AT_MS + 900, '30': CAPTURED_AT_MS + 2_100 }
      },
      { readTable: vi.fn().mockResolvedValue(capture([retained, fresh])), sendSignal, graceMs: 100 }
    )
    await vi.advanceTimersByTimeAsync(100)
    await pending
    expect(sendSignal.mock.calls).toEqual([
      [30, 'SIGTERM'],
      [30, 'SIGKILL']
    ])
  })

  it('does not escalate a PID rejected before SIGTERM even if it later matches', async () => {
    const other = { ...target, pid: 30, pgid: 30 }
    const sendSignal = vi.fn()
    const readTable = vi
      .fn()
      .mockResolvedValueOnce(capture([other]))
      .mockResolvedValue(capture([target, other]))
    const pending = terminateDescendantSnapshot(snapshot([target, other]), {
      readTable,
      sendSignal,
      graceMs: 100
    })
    await vi.advanceTimersByTimeAsync(100)
    await pending
    expect(sendSignal.mock.calls).toEqual([
      [30, 'SIGTERM'],
      [30, 'SIGKILL']
    ])
  })

  it.each(['reject', 'throw'] as const)(
    'fails closed when initial reader can %s',
    async (failure) => {
      const readTable = vi.fn(() => {
        if (failure === 'throw') {
          throw new Error('unreadable')
        }
        return Promise.reject(new Error('unreadable'))
      })
      const sendSignal = vi.fn()
      const pending = terminateDescendantSnapshot(snapshot(), { readTable, sendSignal })
      await vi.advanceTimersByTimeAsync(1_000)
      await pending
      expect(sendSignal).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it('times out the initial read and ignores its eventual success', async () => {
    const gate = deferred<ProcessTableCapture>()
    const sendSignal = vi.fn()
    const readTable = vi.fn(() => gate.promise)
    const pending = terminateDescendantSnapshot(snapshot(), {
      readTable,
      sendSignal,
      timeoutMs: 100,
      awaitEscalation: true
    })
    await vi.advanceTimersByTimeAsync(100)
    await pending
    gate.resolve(capture())
    await vi.advanceTimersByTimeAsync(3_000)
    expect(sendSignal).not.toHaveBeenCalled()
    expect(readTable).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['reject', 'throw'] as const)(
    'fails closed when escalation reader can %s',
    async (failure) => {
      const readTable = vi
        .fn()
        .mockResolvedValueOnce(capture())
        .mockImplementation(() => {
          if (failure === 'throw') {
            throw new Error('unreadable')
          }
          return Promise.reject(new Error('unreadable'))
        })
      const sendSignal = vi.fn()
      const pending = terminateDescendantSnapshot(snapshot(), {
        readTable,
        sendSignal,
        graceMs: 100
      })
      await vi.advanceTimersByTimeAsync(1_100)
      await pending
      expect(sendSignal.mock.calls).toEqual([[20, 'SIGTERM']])
      expect(readTable.mock.calls.length).toBeGreaterThan(2)
      expect(vi.getTimerCount()).toBe(0)
    }
  )
})

describe('SIGTERM sequencing and shutdown budget', () => {
  it.each([false, true])(
    'keeps root kill before grace with awaitEscalation=%s',
    async (awaitEscalation) => {
      const gate = deferred<ProcessTableCapture>()
      const readTable = vi
        .fn()
        .mockResolvedValueOnce(capture([root, target]))
        .mockReturnValueOnce(gate.promise)
        .mockResolvedValue(capture([{ ...target, ppid: 1 }]))
      const events: string[] = []
      let settled = false
      const pending = killWithDescendantSweep(10, () => events.push('root'), {
        platform: 'linux',
        readTable,
        awaitEscalation,
        graceMs: 100,
        sendSignal: (_pid, signal) => events.push(signal)
      }).then(() => {
        settled = true
      })
      await vi.advanceTimersByTimeAsync(20)
      expect(events).toEqual([])
      gate.resolve(capture())
      await vi.advanceTimersByTimeAsync(0)
      expect(events).toEqual(['SIGTERM', 'root'])
      expect(settled).toBe(!awaitEscalation)
      await vi.advanceTimersByTimeAsync(100)
      await pending
      expect(events).toEqual(['SIGTERM', 'root', 'SIGKILL'])
    }
  )

  it('rechecks ownership lost during the initial validation', async () => {
    const gate = deferred<ProcessTableCapture>()
    const readTable = vi
      .fn()
      .mockResolvedValueOnce(capture([root, target]))
      .mockReturnValue(gate.promise)
    const sendSignal = vi.fn()
    const killRoot = vi.fn()
    let owned = true
    const pending = killWithDescendantSweep(10, killRoot, {
      platform: 'linux',
      readTable,
      sendSignal,
      ownsRoot: () => owned
    })
    await vi.advanceTimersByTimeAsync(0)
    owned = false
    gate.resolve(capture())
    await pending
    expect(sendSignal).not.toHaveBeenCalled()
    expect(killRoot).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('still kills the root exactly once after a failed initial validation', async () => {
    const gate = deferred<ProcessTableCapture>()
    const readTable = vi
      .fn()
      .mockResolvedValueOnce(capture([root, target]))
      .mockReturnValue(gate.promise)
    const sendSignal = vi.fn()
    const killRoot = vi.fn()
    const pending = killWithDescendantSweep(10, killRoot, {
      platform: 'linux',
      readTable,
      sendSignal,
      timeoutMs: 100,
      awaitEscalation: true
    })
    await vi.advanceTimersByTimeAsync(99)
    expect(killRoot).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await pending
    gate.resolve(capture())
    await vi.advanceTimersByTimeAsync(3_000)
    expect(sendSignal).not.toHaveBeenCalled()
    expect(killRoot).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reserves a full escalation read budget after a slow initial read', async () => {
    const gate = deferred<ProcessTableCapture>()
    const late = deferred<ProcessTableCapture>()
    const readTable = vi.fn().mockReturnValueOnce(gate.promise).mockReturnValue(late.promise)
    const sendSignal = vi.fn()
    let settled = false
    const pending = terminateDescendantSnapshot(snapshot(), {
      readTable,
      sendSignal,
      timeoutMs: 1_000,
      graceMs: 2_000,
      awaitEscalation: true
    }).then(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(800)
    gate.resolve(capture())
    await vi.advanceTimersByTimeAsync(2_000)
    expect(readTable.mock.calls).toEqual([[1_000], [1_000]])
    await vi.advanceTimersByTimeAsync(999)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await pending
    late.resolve(capture())
    await vi.advanceTimersByTimeAsync(0)
    expect(sendSignal.mock.calls).toEqual([[20, 'SIGTERM']])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds default capture and both independent signal phases', async () => {
    const initialCapture = deferred<ProcessTableCapture>()
    const validation = deferred<ProcessTableCapture>()
    const readTable = vi
      .fn()
      .mockReturnValueOnce(initialCapture.promise)
      .mockReturnValueOnce(validation.promise)
      .mockReturnValue(new Promise<ProcessTableCapture>(() => {}))
    const killRoot = vi.fn()
    const sendSignal = vi.fn()
    let settled = false
    const pending = killWithDescendantSweep(10, killRoot, {
      platform: 'linux',
      readTable,
      sendSignal,
      awaitEscalation: true
    }).then(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(900)
    initialCapture.resolve(capture([root, target]))
    await vi.advanceTimersByTimeAsync(800)
    expect(killRoot).not.toHaveBeenCalled()
    validation.resolve(capture())
    await vi.advanceTimersByTimeAsync(0)
    expect(killRoot).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(2_999)
    expect(settled).toBe(false)
    expect(readTable.mock.calls).toEqual([[1_000], [1_000], [1_000]])
    await vi.advanceTimersByTimeAsync(1)
    await pending
    expect(sendSignal.mock.calls).toEqual([[20, 'SIGTERM']])
    expect(vi.getTimerCount()).toBe(0)
  })
})
