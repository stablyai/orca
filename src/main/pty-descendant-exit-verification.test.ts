import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ProcessTableCapture, ProcessTableRow } from './pty-descendant-termination'
import {
  terminateDescendantSnapshotAndWait,
  terminateDescendantSnapshotWithVerdict
} from './pty-descendant-exit-verification'

const CAPTURED_AT_MS = Date.parse('Tue Jul 14 12:00:00 2026')

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
    // Everything a walk returns was re-derived by it.
    ...(rootPgid === null ? {} : { reDerivedPids: new Set(descendants.map((row) => row.pid)) })
  }
}

describe('terminateDescendantSnapshotAndWait', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('escalates an identity-matched survivor and verifies its exit', async () => {
    const survivor = row(20, 10, 20)
    const sendSignal = vi.fn()
    const readTable = vi
      .fn()
      .mockResolvedValueOnce(tableCapture([survivor]))
      .mockResolvedValueOnce(tableCapture([]))

    const pending = terminateDescendantSnapshotAndWait(snapshot([survivor]), {
      sendSignal,
      readTable,
      graceMs: 0,
      verifyMs: 200
    })
    await vi.advanceTimersByTimeAsync(50)

    await expect(pending).resolves.toBe(true)
    expect(sendSignal.mock.calls).toEqual([
      [20, 'SIGTERM'],
      [20, 'SIGKILL']
    ])
  })

  it('does not claim exit when the verification table is unavailable', async () => {
    const sendSignal = vi.fn()
    const pending = terminateDescendantSnapshotAndWait(snapshot([row(20, 10, 20)]), {
      sendSignal,
      readTable: vi.fn().mockRejectedValue(new Error('ps exploded')),
      verifyMs: 200
    })
    await vi.advanceTimersByTimeAsync(400)

    await expect(pending).resolves.toBe(false)
    expect(sendSignal).toHaveBeenCalledWith(20, 'SIGTERM')
  })

  it('keeps polling past a read that missed its deadline rather than surrendering', async () => {
    const survivor = row(20, 10, 20)
    const readTable = vi
      .fn()
      // A loaded host can miss one read's deadline with the window still open.
      .mockRejectedValueOnce(new Error('ps timed out'))
      .mockResolvedValueOnce(tableCapture([survivor]))
      .mockResolvedValueOnce(tableCapture([]))
    const sendSignal = vi.fn()

    const pending = terminateDescendantSnapshotWithVerdict(snapshot([survivor]), {
      sendSignal,
      readTable,
      graceMs: 0,
      verifyMs: 2_000
    })
    await vi.advanceTimersByTimeAsync(500)

    await expect(pending).resolves.toBe('exited')
    expect(sendSignal.mock.calls).toEqual([
      [20, 'SIGTERM'],
      [20, 'SIGKILL']
    ])
  })

  it('names a survivor seen at the deadline live, never unverifiable', async () => {
    const survivor = row(20, 10, 20)
    const pending = terminateDescendantSnapshotWithVerdict(snapshot([survivor]), {
      sendSignal: vi.fn(),
      readTable: vi.fn().mockResolvedValue(tableCapture([survivor])),
      graceMs: 0,
      verifyMs: 100
    })
    await vi.advanceTimersByTimeAsync(200)

    await expect(pending).resolves.toBe('live')
  })

  it('names an unreadable verification table unverifiable', async () => {
    const pending = terminateDescendantSnapshotWithVerdict(snapshot([row(20, 10, 20)]), {
      sendSignal: vi.fn(),
      readTable: vi.fn().mockRejectedValue(new Error('ps exploded')),
      verifyMs: 200
    })
    await vi.advanceTimersByTimeAsync(400)

    await expect(pending).resolves.toBe('unverifiable')
  })

  it('does not signal a recycled descendant when identity validation is required', async () => {
    const sendSignal = vi.fn()
    const recycled = row(20, 10, 20, 'Tue Jul 14 13:00:00 2026')
    const pending = terminateDescendantSnapshotWithVerdict(
      snapshot([row(20, 10, 20, 'Tue Jul 14 12:00:00 2026')]),
      {
        sendSignal,
        readTable: vi.fn().mockResolvedValue(tableCapture([recycled])),
        requireIdentityBeforeSignal: true,
        verifyMs: 100
      }
    )

    await vi.advanceTimersByTimeAsync(200)
    await expect(pending).resolves.toBe('exited')
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
        // What a merge produces: only the refresh re-derived 30; 20 is retained.
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
