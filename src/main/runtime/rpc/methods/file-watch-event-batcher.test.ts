import { describe, expect, it, vi } from 'vitest'
import type { FsChangeEvent } from '../../../../shared/types'
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
})
