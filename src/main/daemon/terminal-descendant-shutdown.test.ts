import { afterEach, describe, expect, it, vi } from 'vitest'
import { terminateShutdownDescendants } from './terminal-descendant-shutdown'
import { collectDescendantRows, type ProcessTableCapture } from '../pty-descendant-termination'
import type * as DescendantTermination from '../pty-descendant-termination'

const readProcessTable = vi.hoisted(() => vi.fn<() => Promise<ProcessTableCapture>>())
vi.mock('../pty-descendant-termination', async (importOriginal) => {
  const actual = await importOriginal<typeof DescendantTermination>()
  return { ...actual, readProcessTable, sendDescendantSignal: vi.fn() }
})

describe('terminal shutdown process-table batching', () => {
  afterEach(() => vi.useRealTimers())

  it('shares fresh verification reads across a simultaneous twenty-terminal shutdown', async () => {
    vi.useFakeTimers()
    const rows = Array.from({ length: 20 }, (_, index) => [
      {
        pid: 100 + index,
        ppid: 1,
        pgid: 100 + index,
        startedAt: 'Mon Jul 13 12:54:47 2026'
      },
      {
        pid: 200 + index,
        ppid: 100 + index,
        pgid: 100 + index,
        startedAt: 'Mon Jul 13 12:54:47 2026'
      }
    ]).flat()
    readProcessTable
      .mockResolvedValueOnce({ rows, capturedAtMs: Date.now() })
      .mockResolvedValue({ rows: [], capturedAtMs: Date.now() })
    const shutdowns = Array.from({ length: 20 }, (_, index) => {
      const rootPid = 100 + index
      const snapshot = collectDescendantRows(rootPid, [
        { pid: rootPid, ppid: 1, pgid: rootPid, startedAt: 'Mon Jul 13 12:54:47 2026' },
        { pid: rootPid + 100, ppid: rootPid, pgid: rootPid, startedAt: 'Mon Jul 13 12:54:47 2026' }
      ])
      return terminateShutdownDescendants(snapshot)
    })
    await vi.advanceTimersByTimeAsync(3_000)

    await expect(Promise.all(shutdowns)).resolves.toEqual(Array(20).fill('exited'))
    expect(readProcessTable).toHaveBeenCalledTimes(3)
  })
})
