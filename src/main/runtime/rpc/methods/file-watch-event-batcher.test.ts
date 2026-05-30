import { tmpdir } from 'os'
import * as path from 'path'
import { describe, expect, it, vi } from 'vitest'
import type { FsChangeEvent } from '../../../../shared/types'
import { createFileWatchEventBatcher } from './file-watch-event-batcher'

const LARGE_EVENT_COUNT = 150_000

function buildFileWatchEvents(count: number): FsChangeEvent[] {
  const events: FsChangeEvent[] = []
  const root = path.join(tmpdir(), 'orca-file-watch-batch')
  for (let index = 0; index < count; index += 1) {
    events.push({
      kind: 'update',
      absolutePath: path.join(root, `file-${index}.txt`)
    })
  }
  return events
}

describe('createFileWatchEventBatcher', () => {
  it('accepts large watcher event bursts', () => {
    const emit = vi.fn()
    const batcher = createFileWatchEventBatcher(path.join(tmpdir(), 'worktree'), emit)

    batcher.push(buildFileWatchEvents(LARGE_EVENT_COUNT))
    batcher.flush()

    const payload = emit.mock.calls[0]?.[0] as
      | { type: string; worktree: string; events: FsChangeEvent[] }
      | undefined
    expect(payload?.type).toBe('changed')
    expect(payload?.events).toHaveLength(LARGE_EVENT_COUNT)
    expect(payload?.events.at(-1)?.absolutePath).toBe(
      path.join(tmpdir(), 'orca-file-watch-batch', `file-${LARGE_EVENT_COUNT - 1}.txt`)
    )
  })
})
