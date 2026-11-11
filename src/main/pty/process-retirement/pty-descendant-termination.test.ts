import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const execFileMock = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ execFile: execFileMock }))

import {
  captureDescendantSnapshot,
  collectDescendantRows,
  createProcessTableSnapshotReader,
  DESCENDANT_KILL_GRACE_MS,
  killWithDescendantSweep,
  terminateDescendantSnapshot
} from './pty-descendant-termination'
import type { ProcessTableCapture } from './pty-descendant-fresh-table'
import type { ProcessTableRow } from './pty-process-table-parser'
import { terminateDescendantSnapshotWithVerdict } from './pty-descendant-exit-verification'
import { excludeShellBackgroundJobs } from './pty-shell-job-preservation'

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
  return {
    ...(rootPgid === null ? {} : { root: { pid: 10, startedAt: 'Mon Jul 13 12:54:47 2026' } }),
    rootPgid,
    descendants,
    capturedAtMs,
    ...(rootPgid === null ? {} : { reDerivedPids: new Set(descendants.map((row) => row.pid)) })
  }
}

describe('collectDescendantRows', () => {
  it("excludes only the shell's own background jobs; agent-made process groups stay swept", () => {
    const tty = (pid: number, ppid: number, pgid: number, tpgid: number) => ({
      ...row(pid, ppid, pgid),
      tpgid
    })
    // Shell 10: foreground agent 20 (tool 21, setsid'd MCP 22, setpgid'd MCP 23 keeping the tty)
    // and nohup/disown job 30 (child 31).
    const table = [
      tty(10, 1, 10, 20),
      tty(20, 10, 20, 20),
      tty(21, 20, 20, 20),
      tty(22, 20, 22, -1),
      tty(23, 20, 23, 20),
      tty(30, 10, 30, 20),
      tty(31, 30, 30, 20)
    ]
    const snapshot = collectDescendantRows(10, table, CAPTURED_AT_MS)
    expect(snapshot.descendants.map((r) => r.pid)).toEqual([20, 30, 21, 22, 23, 31])
    expect(excludeShellBackgroundJobs(snapshot, false).descendants.map((r) => r.pid)).toEqual([
      20, 21, 22, 23
    ])
  })

  it('finds the job-control shell under the macOS login(1) wrapper', () => {
    const tty = (pid: number, ppid: number, pgid: number, tpgid: number) => ({
      ...row(pid, ppid, pgid),
      tpgid
    })
    // login 5 -> shell 10 (own group) -> nohup job 30, foreground agent 20 -> NewGroup MCP 23.
    const table = [
      tty(5, 1, 5, 20),
      tty(10, 5, 10, 20),
      tty(20, 10, 20, 20),
      tty(23, 20, 23, 20),
      tty(30, 10, 30, 20)
    ]
    const snapshot = collectDescendantRows(5, table, CAPTURED_AT_MS)
    expect(excludeShellBackgroundJobs(snapshot, true).descendants.map((r) => r.pid)).toEqual([
      10, 20, 23
    ])
    // Treating login as the shell would spare the shell's own group and sweep the nohup job.
    expect(excludeShellBackgroundJobs(snapshot, false).descendants.map((r) => r.pid)).toEqual([
      20, 30, 23
    ])
  })
})

describe('captureDescendantSnapshot', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('records the identity boundary before ps starts even when it crosses a second', async () => {
    vi.setSystemTime(CAPTURED_AT_MS + 900)
    execFileMock.mockImplementation((...args: unknown[]) => {
      const callback = args.at(-1) as (error: Error | null, stdout: string) => void
      vi.setSystemTime(CAPTURED_AT_MS + 1_100)
      callback(
        null,
        ['10 1 10 0 Tue Jul 14 12:00:00 2026', '20 10 20 0 Tue Jul 14 12:00:00 2026'].join('\n')
      )
    })

    const result = await captureDescendantSnapshot(10, { platform: 'darwin' })

    expect(result?.capturedAtMs).toBe(CAPTURED_AT_MS + 900)
    expect(result?.descendants).toEqual([
      { ...row(20, 10, 20, 'Tue Jul 14 12:00:00 2026'), tpgid: 0 }
    ])
  })
})

describe('terminateDescendantSnapshot', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('SIGKILLs only identity-matched survivors after the grace window', async () => {
    const survivor = row(30, 20, 30)
    const exited = row(20, 10, 20)
    const recycled = row(40, 30, 40)
    const ambiguous = row(50, 30, 50)
    const sendSignal = vi.fn()
    // At escalation, 30 retains its identity, 20 is gone, and 40’s PID belongs to another process.
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

  it("uses each row's capture boundary when escalating a merged snapshot", async () => {
    const oldBoundary = CAPTURED_AT_MS + 900
    const refreshBoundary = CAPTURED_AT_MS + 2_100
    const retained = row(20, 10, 20, 'Tue Jul 14 12:00:00 2026')
    const fresh = row(30, 10, 30, 'Tue Jul 14 12:00:01 2026')
    const sendSignal = vi.fn()
    terminateDescendantSnapshot(
      {
        ...snapshot([retained, fresh], 10, refreshBoundary),
        capturedAtMsByPid: { '20': oldBoundary, '30': refreshBoundary }
      },
      {
        sendSignal,
        readTable: vi.fn().mockResolvedValue(tableCapture([retained, fresh]))
      }
    )
    sendSignal.mockClear()

    await vi.advanceTimersByTimeAsync(DESCENDANT_KILL_GRACE_MS)

    // Retained PID 20 still has capture-second ambiguity; refreshed PID 30 is old enough to escalate.
    expect(sendSignal.mock.calls).toEqual([[30, 'SIGKILL']])
  })
})

describe('terminateDescendantSnapshotAndWait', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('never escalates a duplicate PID observation during shutdown verification', async () => {
    const survivor = row(20, 10, 20)
    const sendSignal = vi.fn()
    const pending = terminateDescendantSnapshotWithVerdict(snapshot([survivor]), {
      sendSignal,
      readTable: async () => tableCapture([survivor, survivor]),
      graceMs: 0,
      verifyMs: 100,
      keepAlive: true,
      requireIdentityBeforeSignal: true
    })
    await vi.advanceTimersByTimeAsync(200)

    await expect(pending).resolves.toBe('unverifiable')
    expect(sendSignal).not.toHaveBeenCalled()
  })

  it('uses row-scoped boundaries for forced cleanup in the exit verifier', async () => {
    const oldBoundary = CAPTURED_AT_MS + 900
    const refreshBoundary = CAPTURED_AT_MS + 2_100
    const retained = row(20, 10, 20, 'Tue Jul 14 12:00:00 2026')
    const fresh = row(30, 10, 30, 'Tue Jul 14 12:00:01 2026')
    const sendSignal = vi.fn()
    const pending = terminateDescendantSnapshotWithVerdict(
      {
        ...snapshot([retained, fresh], 10, refreshBoundary),
        capturedAtMsByPid: { '20': oldBoundary, '30': refreshBoundary },
        // Refresh proves ancestry only for 30; 20 was retained from the earlier capture.
        reDerivedPids: new Set([30])
      },
      {
        sendSignal,
        readTable: vi.fn().mockResolvedValue(tableCapture([retained, fresh])),
        requireIdentityBeforeSignal: true,
        graceMs: 0,
        verifyMs: 100
      }
    )
    await vi.advanceTimersByTimeAsync(200)

    await expect(pending).resolves.toBe('live')
    expect(sendSignal.mock.calls).toEqual([
      [20, 'SIGTERM'],
      [30, 'SIGTERM'],
      [30, 'SIGKILL']
    ])
  })
})

describe('createProcessTableSnapshotReader', () => {
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
    // A successor scan must start within its callers’ deadline instead of waiting for the prior scan.
    expect(readFresh).toHaveBeenCalledTimes(2)
    firstGate.resolve(tableCapture([row(10, 1, 10)], CAPTURED_AT_MS))
    await first

    const newer = tableCapture([row(20, 1, 20)], CAPTURED_AT_MS + 1_000)
    secondGate.resolve(newer)
    await expect(Promise.all([laterA, laterB])).resolves.toEqual([newer, newer])
  })
})

describe('killWithDescendantSweep', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('retains a shutdown owner until descendant cleanup finishes after root signalling', async () => {
    const events: string[] = []
    let finishDescendants = (): void => {}
    const completion = new Promise<void>((resolve) => {
      finishDescendants = resolve
    })
    const pending = killWithDescendantSweep(10, () => events.push('root'), {
      platform: 'linux',
      readTable: async () => tableCapture([row(10, 1, 10), row(20, 10, 20)]),
      terminateDescendants: () => {
        events.push('descendants')
        return completion
      },
      awaitEscalation: true
    }).then(() => events.push('finished'))

    await vi.advanceTimersByTimeAsync(0)
    expect(events).toEqual(['descendants'])
    finishDescendants()
    await pending
    expect(events).toEqual(['descendants', 'root', 'finished'])
  })

  it('on Windows terminates the owning job instead of probing and taskkilling', async () => {
    const events: string[] = []
    const terminateOwnedTree = vi.fn(() => {
      events.push('job-kill')
      return 'terminated' as const
    })
    const killWindowsTree = vi.fn(async () => {})
    const verifyTreeKillTarget = vi.fn(async () => 'own' as const)
    const killRoot = vi.fn(() => events.push('root-kill'))

    await killWithDescendantSweep(4242, killRoot, {
      platform: 'win32',
      terminateOwnedTree,
      killWindowsTree,
      verifyTreeKillTarget
    })

    expect(terminateOwnedTree).toHaveBeenCalledOnce()
    expect(verifyTreeKillTarget).not.toHaveBeenCalled()
    expect(killWindowsTree).not.toHaveBeenCalled()
    // Killing job processes still leaves the PTY handle to close.
    expect(events).toEqual(['job-kill', 'root-kill'])
  })

  it('on Windows re-checks ownership lost while the identity probe ran', async () => {
    const killWindowsTree = vi.fn(async () => {})
    const killRoot = vi.fn()
    let alive = true
    await killWithDescendantSweep(4242, killRoot, {
      platform: 'win32',
      killWindowsTree,
      ownsRoot: () => alive,
      verifyTreeKillTarget: async () => {
        alive = false
        return 'own'
      }
    })
    expect(killWindowsTree).not.toHaveBeenCalled()
    expect(killRoot).toHaveBeenCalledOnce()
  })
})
