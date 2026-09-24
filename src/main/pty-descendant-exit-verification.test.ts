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
      .mockResolvedValueOnce(capture([first]))
      .mockResolvedValueOnce(capture([first, later]))
      .mockResolvedValue(capture([]))
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

  it('keeps an omitted target unverifiable when partial reads never show its identity', async () => {
    const first = row(20)
    const omitted = row(30)
    const snapshot = collectDescendantRows(10, [row(10, 1), first, omitted], CAPTURED_AT)
    const sendSignal = vi.fn()
    const pending = terminateDescendantSnapshotWithVerdict(snapshot, {
      readTable: vi
        .fn()
        .mockResolvedValueOnce(capture([first]))
        .mockResolvedValue(capture([])),
      sendSignal,
      requireIdentityBeforeSignal: true,
      graceMs: 0,
      verifyMs: 100
    })
    await vi.advanceTimersByTimeAsync(200)

    await expect(pending).resolves.toBe('unverifiable')
    expect(sendSignal).toHaveBeenCalledWith(first.pid, 'SIGTERM')
    expect(sendSignal).not.toHaveBeenCalledWith(omitted.pid, 'SIGTERM')
  })

  it('escalates a survivor omitted at the first force-kill read when it reappears', async () => {
    const first = row(20)
    const later = row(30)
    const snapshot = collectDescendantRows(10, [row(10, 1), first, later], CAPTURED_AT)
    const readTable = vi
      .fn()
      .mockResolvedValueOnce(capture([first, later]))
      .mockResolvedValueOnce(capture([first]))
      .mockResolvedValueOnce(capture([first, later]))
      .mockResolvedValue(capture([]))
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
