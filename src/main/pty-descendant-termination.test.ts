import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const execFileMock = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ execFile: execFileMock }))

import {
  captureDescendantSnapshot,
  collectDescendantRows,
  createProcessTableSnapshotReader,
  DESCENDANT_KILL_GRACE_MS,
  DESCENDANT_SNAPSHOT_TIMEOUT_MS,
  killWithDescendantSweep,
  parseProcessTable,
  terminateDescendantSnapshot,
  type ProcessTableCapture,
  type ProcessTableRow
} from './pty-descendant-termination'

const CAPTURED_AT_MS = Date.parse('Tue Jul 14 12:00:00 2026')

beforeEach(() => {
  execFileMock.mockReset()
  execFileMock.mockImplementation((...args: unknown[]) => {
    const callback = args.at(-1) as (error: Error | null, stdout: string) => void
    callback(null, '10 1 10 Mon Jul 13 12:54:47 2026')
  })
})

function row(
  pid: number,
  ppid: number,
  pgid: number,
  startedAt = 'Mon Jul 13 12:54:47 2026'
): ProcessTableRow {
  return { pid, ppid, pgid, startedAt }
}

function tableCapture(rows: ProcessTableRow[], capturedAtMs = CAPTURED_AT_MS): ProcessTableCapture {
  return { rows, capturedAtMs }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

function snapshot(
  descendants: ProcessTableRow[],
  rootPgid: number | null = 10,
  capturedAtMs = CAPTURED_AT_MS
) {
  return { rootPgid, descendants, capturedAtMs }
}

describe('parseProcessTable', () => {
  it('parses pid/ppid/pgid and keeps the space-containing lstart verbatim', () => {
    const rows = parseProcessTable(
      [
        '  101   1  101 Mon Jul 13 12:54:47 2026',
        '42017 101 42017 Tue Jul 14 01:02:03 2026  ',
        '',
        'not a process line'
      ].join('\n')
    )
    expect(rows).toEqual([
      { pid: 101, ppid: 1, pgid: 101, startedAt: 'Mon Jul 13 12:54:47 2026' },
      { pid: 42017, ppid: 101, pgid: 42017, startedAt: 'Tue Jul 14 01:02:03 2026' }
    ])
  })
})

describe('collectDescendantRows', () => {
  it('walks detached-pgid descendants once even when a non-atomic table looks cyclic', () => {
    // shell(10) -> agent(20, own job pgid) -> detached tool shell(30, own
    // session-style pgid) -> git(31). 99 is unrelated.
    const table = [
      row(10, 1, 10),
      row(20, 10, 20),
      row(30, 20, 30),
      row(31, 30, 30),
      row(20, 31, 20), // PID reuse can make a non-atomic ps read look cyclic.
      row(99, 1, 99)
    ]
    const snapshot = collectDescendantRows(10, table, CAPTURED_AT_MS)
    expect(snapshot.rootPgid).toBe(10)
    expect(snapshot.descendants.map((r) => r.pid)).toEqual([20, 30, 31])
    expect(snapshot.capturedAtMs).toBe(CAPTURED_AT_MS)
  })

  it('sweeps nothing when the root row is already gone (a vacated PID has no findable tree)', () => {
    // The root (10) is absent from the table: it has exited. Row 20 still points
    // at ppid 10, but that is a PID-reuse coincidence, not a real descendant —
    // never collect it.
    const snapshot = collectDescendantRows(10, [row(20, 10, 20)], CAPTURED_AT_MS)
    expect(snapshot.rootPgid).toBeNull()
    expect(snapshot.descendants).toEqual([])
  })

  it('does not sweep unrelated processes that merely reference a vacated root PID as ppid', () => {
    // The PTY root (500) has exited, so its row is absent. Other live processes
    // (501/502/503) still list ppid 500 — either not-yet-reparented orphans or, in
    // the hazardous case, children of a process that recycled PID 500. The walk is
    // seeded only by a stale number, so it cannot tell them apart and must sweep
    // none. (A root PID recycled to a *live* process would appear in the table and
    // is out of scope for this guard.)
    const table = [row(501, 500, 500), row(502, 500, 500), row(503, 500, 500)]
    const snapshot = collectDescendantRows(500, table, CAPTURED_AT_MS)
    expect(snapshot.descendants).toEqual([])
  })
})

describe('captureDescendantSnapshot', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('resolves the descendant tree on POSIX', async () => {
    const readTable = vi.fn().mockResolvedValue(tableCapture([row(10, 1, 10), row(20, 10, 20)]))
    const result = await captureDescendantSnapshot(10, {
      readTable,
      platform: 'darwin'
    })
    expect(result).toEqual(snapshot([row(20, 10, 20)]))
    expect(vi.getTimerCount()).toBe(0)
  })

  it('captures no descendants and signals nothing when the root PID was already recycled', async () => {
    // End-to-end proof for the #9191-class hazard: the captured PTY root (500) is
    // gone; only unrelated live processes reference its vacated PID. Neither the
    // snapshot nor the terminator may touch them.
    const readTable = vi
      .fn()
      .mockResolvedValue(tableCapture([row(501, 500, 500), row(502, 500, 500), row(503, 500, 500)]))
    const result = await captureDescendantSnapshot(500, { readTable, platform: 'darwin' })
    expect(result?.descendants).toEqual([])
    const sendSignal = vi.fn()
    terminateDescendantSnapshot(result!, { sendSignal })
    expect(sendSignal).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('is a null no-op on Windows', async () => {
    const readTable = vi.fn()
    expect(await captureDescendantSnapshot(10, { readTable, platform: 'win32' })).toBeNull()
    expect(readTable).not.toHaveBeenCalled()
  })

  it('degrades to null when ps fails', async () => {
    const readTable = vi.fn().mockRejectedValue(new Error('ps exploded'))
    expect(await captureDescendantSnapshot(10, { readTable, platform: 'linux' })).toBeNull()
  })

  it('degrades to null when a custom process-table reader throws synchronously', async () => {
    const readTable = vi.fn(() => {
      throw new Error('reader exploded')
    })
    expect(await captureDescendantSnapshot(10, { readTable, platform: 'linux' })).toBeNull()
  })

  it('degrades to null when ps hangs past the timeout instead of blocking teardown', async () => {
    const readTable = vi.fn().mockReturnValue(new Promise<ProcessTableCapture>(() => {}))
    const pending = captureDescendantSnapshot(10, {
      readTable,
      platform: 'darwin',
      timeoutMs: 1_000
    })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(await pending).toBeNull()
  })

  it('gives the production ps subprocess a hard SIGKILL timeout', async () => {
    const result = await captureDescendantSnapshot(10, {
      platform: 'darwin',
      timeoutMs: 321
    })
    expect(result).not.toBeNull()
    expect(execFileMock).toHaveBeenCalledWith(
      'ps',
      ['-axo', 'pid=,ppid=,pgid=,lstart='],
      expect.objectContaining({
        timeout: 321,
        killSignal: 'SIGKILL',
        env: expect.objectContaining({ LANG: 'C', LC_ALL: 'C' })
      }),
      expect.any(Function)
    )
  })

  it('records the identity boundary before ps starts even when it crosses a second', async () => {
    vi.setSystemTime(CAPTURED_AT_MS + 900)
    execFileMock.mockImplementation((...args: unknown[]) => {
      const callback = args.at(-1) as (error: Error | null, stdout: string) => void
      vi.setSystemTime(CAPTURED_AT_MS + 1_100)
      callback(
        null,
        ['10 1 10 Tue Jul 14 12:00:00 2026', '20 10 20 Tue Jul 14 12:00:00 2026'].join('\n')
      )
    })

    const result = await captureDescendantSnapshot(10, { platform: 'darwin' })

    expect(result?.capturedAtMs).toBe(CAPTURED_AT_MS + 900)
    expect(result?.descendants).toEqual([row(20, 10, 20, 'Tue Jul 14 12:00:00 2026')])
  })
})

describe('terminateDescendantSnapshot', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('SIGTERMs every snapshotted descendant immediately', () => {
    const sendSignal = vi.fn()
    terminateDescendantSnapshot(snapshot([row(20, 10, 20), row(30, 20, 30)]), {
      sendSignal,
      readTable: vi.fn().mockResolvedValue(tableCapture([]))
    })
    expect(sendSignal.mock.calls).toEqual([
      [20, 'SIGTERM'],
      [30, 'SIGTERM']
    ])
  })

  it('SIGKILLs only identity-matched survivors after the grace window', async () => {
    const survivor = row(30, 20, 30)
    const exited = row(20, 10, 20)
    const recycled = row(40, 30, 40)
    const ambiguous = row(50, 30, 50)
    const sendSignal = vi.fn()
    // At escalation time: 30 survives unchanged, 20 is gone, 40's pid now
    // belongs to a different (recycled) process with a different start time.
    const readTable = vi
      .fn()
      .mockResolvedValue(
        tableCapture([
          survivor,
          { ...recycled, startedAt: 'Tue Jul 14 09:00:00 2026' },
          ambiguous,
          { ...ambiguous, startedAt: 'Tue Jul 14 10:00:00 2026' }
        ])
      )
    terminateDescendantSnapshot(snapshot([exited, survivor, recycled, ambiguous]), {
      sendSignal,
      readTable
    })
    sendSignal.mockClear()
    await vi.advanceTimersByTimeAsync(DESCENDANT_KILL_GRACE_MS)
    expect(sendSignal.mock.calls).toEqual([[30, 'SIGKILL']])
  })

  it('never escalates when the identity re-read fails', async () => {
    const sendSignal = vi.fn()
    const readTable = vi.fn().mockRejectedValue(new Error('ps exploded'))
    terminateDescendantSnapshot(snapshot([row(20, 10, 20)]), { sendSignal, readTable })
    sendSignal.mockClear()
    await vi.advanceTimersByTimeAsync(DESCENDANT_KILL_GRACE_MS)
    expect(sendSignal).not.toHaveBeenCalled()
  })

  it('schedules no escalation for an empty descendant set', () => {
    const sendSignal = vi.fn()
    const readTable = vi.fn()
    terminateDescendantSnapshot(snapshot([]), { sendSignal, readTable })
    expect(vi.getTimerCount()).toBe(0)
    expect(sendSignal).not.toHaveBeenCalled()
  })

  it('uses the source scan boundary when a caller crosses into the next second', async () => {
    const sameSecond = row(20, 10, 20, 'Tue Jul 14 12:00:00 2026')
    const sendSignal = vi.fn()
    terminateDescendantSnapshot(snapshot([sameSecond], 10, CAPTURED_AT_MS + 900), {
      sendSignal,
      readTable: vi.fn().mockResolvedValue(tableCapture([sameSecond], CAPTURED_AT_MS + 3_000))
    })
    sendSignal.mockClear()
    await vi.advanceTimersByTimeAsync(DESCENDANT_KILL_GRACE_MS)
    expect(sendSignal).not.toHaveBeenCalled()
  })

  it('bounds a wedged escalation read and releases its deadline timer', async () => {
    const sendSignal = vi.fn()
    terminateDescendantSnapshot(snapshot([row(20, 10, 20)]), {
      sendSignal,
      readTable: vi.fn().mockReturnValue(new Promise<ProcessTableCapture>(() => {}))
    })
    sendSignal.mockClear()
    await vi.advanceTimersByTimeAsync(DESCENDANT_KILL_GRACE_MS + DESCENDANT_SNAPSHOT_TIMEOUT_MS)
    expect(sendSignal).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('createProcessTableSnapshotReader', () => {
  it('coalesces same-turn teardown requests onto one fresh scan', async () => {
    const capture = tableCapture([row(10, 1, 10)])
    const readFresh = vi.fn().mockResolvedValue(capture)
    const readTable = createProcessTableSnapshotReader(readFresh)

    const results = await Promise.all(Array.from({ length: 20 }, () => readTable(1_000)))
    expect(results.every((result) => result === capture)).toBe(true)
    expect(readFresh).toHaveBeenCalledOnce()

    await readTable(1_000)
    expect(readFresh).toHaveBeenCalledTimes(2)
  })

  it('queues a post-request scan when another scan has already started', async () => {
    const firstGate = deferred<ProcessTableCapture>()
    const secondGate = deferred<ProcessTableCapture>()
    const readFresh = vi
      .fn()
      .mockReturnValueOnce(firstGate.promise)
      .mockReturnValueOnce(secondGate.promise)
    const readTable = createProcessTableSnapshotReader(readFresh)

    const first = readTable()
    await Promise.resolve()
    expect(readFresh).toHaveBeenCalledOnce()

    const laterA = readTable()
    const laterB = readTable()
    await Promise.resolve()
    // A successor must begin inside its callers' deadline. Waiting for the
    // prior scan can make both callers time out before their own scan starts.
    expect(readFresh).toHaveBeenCalledTimes(2)
    firstGate.resolve(tableCapture([row(10, 1, 10)], CAPTURED_AT_MS))
    await first

    const newer = tableCapture([row(20, 1, 20)], CAPTURED_AT_MS + 1_000)
    secondGate.resolve(newer)
    await expect(Promise.all([laterA, laterB])).resolves.toEqual([newer, newer])
  })

  it('retries after failed process-table reads', async () => {
    const readFresh = vi
      .fn()
      .mockRejectedValueOnce(new Error('ps failed'))
      .mockResolvedValueOnce(tableCapture([]))
    const readTable = createProcessTableSnapshotReader(readFresh)
    await expect(readTable()).rejects.toThrow('ps failed')
    await expect(readTable()).resolves.toEqual(tableCapture([]))
    expect(readFresh).toHaveBeenCalledTimes(2)
  })
})

describe('killWithDescendantSweep', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('signals descendants after snapshot resolution, then kills the root', async () => {
    const events: string[] = []
    const sendSignal = vi.fn(() => events.push('descendant-term'))
    const readTable = vi.fn().mockResolvedValue(tableCapture([row(10, 1, 10), row(20, 10, 20)]))
    const killRoot = vi.fn(() => events.push('root-kill'))
    const pending = killWithDescendantSweep(10, killRoot, {
      readTable,
      sendSignal,
      platform: 'darwin'
    })
    expect(killRoot).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(0)
    await pending
    expect(killRoot).toHaveBeenCalledOnce()
    expect(sendSignal.mock.calls).toEqual([[20, 'SIGTERM']])
    expect(events).toEqual(['descendant-term', 'root-kill'])
  })

  it('still kills the root when the snapshot is unavailable', async () => {
    const sendSignal = vi.fn()
    const readTable = vi.fn().mockRejectedValue(new Error('ps exploded'))
    const killRoot = vi.fn()
    const pending = killWithDescendantSweep(10, killRoot, {
      readTable,
      sendSignal,
      platform: 'darwin'
    })
    await vi.advanceTimersByTimeAsync(0)
    await pending
    expect(killRoot).toHaveBeenCalledOnce()
    expect(sendSignal).not.toHaveBeenCalled()
  })

  it('does not signal a captured tree after the caller loses root ownership', async () => {
    const sendSignal = vi.fn()
    const killRoot = vi.fn()
    const readTable = vi.fn().mockResolvedValue(tableCapture([row(10, 1, 10), row(20, 10, 20)]))
    const ownsRoot = vi.fn(() => false)

    await killWithDescendantSweep(10, killRoot, {
      readTable,
      sendSignal,
      platform: 'darwin',
      ownsRoot
    })

    expect(ownsRoot).toHaveBeenCalledOnce()
    expect(sendSignal).not.toHaveBeenCalled()
    expect(killRoot).toHaveBeenCalledOnce()
  })
})
