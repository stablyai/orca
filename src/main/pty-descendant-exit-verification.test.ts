import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { terminateDescendantSnapshotWithVerdict } from './pty-descendant-exit-verification'
import {
  collectDescendantRows,
  type ProcessTableCapture,
  type ProcessTableRow
} from './pty-descendant-termination'

const CAPTURED_AT = Date.parse('Tue Jul 14 12:00:00 2026')
const STARTED_BEFORE = 'Mon Jul 13 12:54:47 2026'
const STARTED_DURING = 'Tue Jul 14 12:00:00 2026'

function row(pid: number, ppid = 10, startedAt = STARTED_BEFORE): ProcessTableRow {
  return { pid, ppid, pgid: pid, startedAt }
}

function capture(rows: ProcessTableRow[]): ProcessTableCapture {
  return { rows, capturedAtMs: Date.now() }
}

describe('descendant exit verification across partial process-table reads', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(CAPTURED_AT + 100)
  })

  afterEach(() => vi.useRealTimers())

  it('signals a descendant omitted from the first identity read when it reappears', async () => {
    const first = row(20)
    const later = row(30)
    const snapshot = collectDescendantRows(10, [row(10, 1), first, later], CAPTURED_AT)
    const readTable = vi
      .fn()
      .mockImplementationOnce(async () => capture([first]))
      .mockImplementationOnce(async () => capture([first, later]))
      .mockImplementation(async () => capture([]))
    const sendSignal = vi.fn()
    const pending = terminateDescendantSnapshotWithVerdict(snapshot, {
      readTable,
      sendSignal,
      requireIdentityBeforeSignal: true,
      graceMs: 200,
      verifyMs: 300
    })
    await vi.advanceTimersByTimeAsync(400)

    await expect(pending).resolves.toBe('exited')
    expect(sendSignal.mock.calls).toEqual([
      [20, 'SIGTERM'],
      [30, 'SIGTERM']
    ])
  })

  it('proves a target gone that only the snapshot saw, once two later reads miss it', async () => {
    // A root that exits on its own takes a short-lived child with it before the first poll.
    const snapshot = collectDescendantRows(10, [row(10, 1), row(20)], CAPTURED_AT)
    const sendSignal = vi.fn()
    const pending = terminateDescendantSnapshotWithVerdict(snapshot, {
      readTable: vi.fn().mockImplementation(async () => capture([])),
      sendSignal,
      requireIdentityBeforeSignal: true,
      graceMs: 0,
      verifyMs: 3_500
    })
    let verdict: string | undefined
    void pending.then((value) => {
      verdict = value
    })
    // Proven within a few polls, not by waiting out the verification window.
    await vi.advanceTimersByTimeAsync(200)

    expect(verdict).toBe('exited')
    expect(sendSignal).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(4_000)
  })

  it('does not count an absence from a read that started before the target was seen', async () => {
    const unseen = row(30)
    const snapshot = collectDescendantRows(10, [row(10, 1), unseen], CAPTURED_AT)
    const sendSignal = vi.fn()
    // A shared read already in flight when the snapshot ran cannot list a descendant forked since.
    const staleRead = { rows: [], capturedAtMs: CAPTURED_AT - 1 }
    const pending = terminateDescendantSnapshotWithVerdict(snapshot, {
      readTable: vi.fn().mockResolvedValue(staleRead),
      sendSignal,
      requireIdentityBeforeSignal: true,
      graceMs: 0,
      verifyMs: 100
    })
    await vi.advanceTimersByTimeAsync(200)

    await expect(pending).resolves.toBe('unverifiable')
    expect(sendSignal).not.toHaveBeenCalled()
  })

  it('escalates a survivor omitted at the first force-kill read when it reappears', async () => {
    const first = row(20)
    const later = row(30)
    const snapshot = collectDescendantRows(10, [row(10, 1), first, later], CAPTURED_AT)
    const readTable = vi
      .fn()
      .mockImplementationOnce(async () => capture([first, later]))
      .mockImplementationOnce(async () => capture([first]))
      .mockImplementationOnce(async () => capture([first, later]))
      .mockImplementation(async () => capture([]))
    const sendSignal = vi.fn()
    const pending = terminateDescendantSnapshotWithVerdict(snapshot, {
      readTable,
      sendSignal,
      requireIdentityBeforeSignal: true,
      graceMs: 50,
      verifyMs: 300
    })
    await vi.advanceTimersByTimeAsync(400)

    await expect(pending).resolves.toBe('exited')
    expect(sendSignal.mock.calls).toEqual([
      [20, 'SIGTERM'],
      [30, 'SIGTERM'],
      [20, 'SIGKILL'],
      [30, 'SIGKILL']
    ])
  })

  it.each(['absent root', 'changed root', 'reparented target', 'ambiguous parent'])(
    'withholds birth-second escalation with an %s in the fresh read',
    async (scenario) => {
      const root = row(10, 1)
      const parent = row(20)
      const child = row(30, 20, STARTED_DURING)
      const snapshot = collectDescendantRows(10, [root, parent, child], CAPTURED_AT)
      const rows =
        scenario === 'absent root'
          ? [parent, child]
          : scenario === 'changed root'
            ? [row(10, 1, STARTED_DURING), parent, child]
            : scenario === 'reparented target'
              ? [root, parent, { ...child, ppid: 1 }]
              : [root, parent, { ...parent, ppid: 1 }, child]
      const sendSignal = vi.fn()
      const pending = terminateDescendantSnapshotWithVerdict(snapshot, {
        readTable: async () => capture(rows),
        sendSignal,
        requireIdentityBeforeSignal: true,
        graceMs: 0,
        verifyMs: 100
      })
      await vi.advanceTimersByTimeAsync(200)

      await pending
      expect(sendSignal).not.toHaveBeenCalledWith(child.pid, 'SIGKILL')
    }
  )

  it('escalates a birth-second descendant freshly re-derived from the same root', async () => {
    const rows = [row(10, 1), row(20, 10, STARTED_DURING)]
    const snapshot = collectDescendantRows(10, rows, CAPTURED_AT)
    const sendSignal = vi.fn()
    const pending = terminateDescendantSnapshotWithVerdict(snapshot, {
      readTable: async () => capture(rows),
      sendSignal,
      requireIdentityBeforeSignal: true,
      graceMs: 0,
      verifyMs: 100
    })
    await vi.advanceTimersByTimeAsync(200)

    await expect(pending).resolves.toBe('live')
    expect(sendSignal.mock.calls).toEqual([
      [20, 'SIGTERM'],
      [20, 'SIGKILL']
    ])
  })
})
