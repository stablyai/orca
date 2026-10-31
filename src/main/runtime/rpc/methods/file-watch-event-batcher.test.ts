import { describe, expect, it, vi } from 'vitest'
import type { FsChangeEvent } from '../../../../shared/filesystem-entry-types'
import {
  WATCH_BATCH_INTERVAL_MS,
  WATCH_BATCH_LEADING_MS
} from '../../../../shared/filesystem-watch-batch-window'
import { createFileWatchEventBatcher } from './file-watch-event-batcher'

describe('createFileWatchEventBatcher', () => {
  it('keeps precise watcher events while the batch is under the overflow limit', () => {
    const emit = vi.fn()
    const batcher = createFileWatchEventBatcher('worktree-1', emit)
    const events: FsChangeEvent[] = [
      { kind: 'update', absolutePath: '/repo/file-a.ts' },
      { kind: 'delete', absolutePath: '/repo/file-b.ts' }
    ]

    batcher.push(events)
    batcher.flush()

    expect(emit).toHaveBeenCalledWith({
      type: 'changed',
      worktree: 'worktree-1',
      events
    })
  })

  it('collapses very large watcher bursts without spreading them onto the stack', () => {
    vi.useFakeTimers()
    try {
      const emit = vi.fn()
      const batcher = createFileWatchEventBatcher('worktree-1', emit)
      const event: FsChangeEvent = { kind: 'update', absolutePath: '/repo/file.ts' }
      const burst = Array.from({ length: 200_000 }, () => event)

      expect(() => batcher.push(burst)).not.toThrow()
      batcher.flush()

      expect(emit).toHaveBeenCalledWith({
        type: 'changed',
        worktree: 'worktree-1',
        events: [{ kind: 'overflow', absolutePath: '/repo/file.ts' }]
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('flushes at the leading delay and keeps a sustained stream on the interval', () => {
    vi.useFakeTimers()
    try {
      const emit = vi.fn()
      const batcher = createFileWatchEventBatcher('worktree-1', emit, 'interval')
      const event: FsChangeEvent = { kind: 'update', absolutePath: '/repo/file.ts' }

      batcher.push([event])
      vi.advanceTimersByTime(WATCH_BATCH_LEADING_MS - 1)
      batcher.push([event])
      expect(emit).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      expect(emit).toHaveBeenCalledTimes(1)

      for (let elapsed = 0; elapsed < 1_000; elapsed += 10) {
        batcher.push([event])
        vi.advanceTimersByTime(10)
      }
      expect(emit.mock.calls.length).toBeGreaterThanOrEqual(1_000 / WATCH_BATCH_INTERVAL_MS)
      expect(emit.mock.calls.length).toBeLessThanOrEqual(1 + 1_000 / WATCH_BATCH_INTERVAL_MS)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps legacy trailing batching for subscribers that did not ask for the interval cadence', () => {
    vi.useFakeTimers()
    try {
      const emit = vi.fn()
      const batcher = createFileWatchEventBatcher('worktree-1', emit)
      const event: FsChangeEvent = { kind: 'update', absolutePath: '/repo/file.ts' }

      batcher.push([event])
      vi.advanceTimersByTime(149)
      expect(emit).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      expect(emit).toHaveBeenCalledTimes(1)

      emit.mockClear()
      for (let elapsed = 0; elapsed < 1_050; elapsed += 10) {
        batcher.push([event])
        vi.advanceTimersByTime(10)
      }
      // Sustained stream flushes only at the 500 ms cap, as older clients expect.
      expect(emit).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('lets an older client that restarts a 200 ms read per batch still apply updates', () => {
    vi.useFakeTimers()
    try {
      let applied = 0
      let readGeneration = 0
      // Older clients start a fresh read per batch and discard superseded results.
      const batcher = createFileWatchEventBatcher('worktree-1', () => {
        const generation = ++readGeneration
        setTimeout(() => {
          if (generation === readGeneration) {
            applied++
          }
        }, 200)
      })
      const event: FsChangeEvent = { kind: 'update', absolutePath: '/repo/file.ts' }
      for (let elapsed = 0; elapsed < 3_000; elapsed += 10) {
        batcher.push([event])
        vi.advanceTimersByTime(10)
      }
      expect(applied).toBeGreaterThan(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
