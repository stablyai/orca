import { describe, expect, it, vi } from 'vitest'
import type { Event as WatcherEvent } from '@parcel/watcher'

vi.mock('fs/promises', () => ({
  stat: vi.fn()
}))

import { stat } from 'fs/promises'
import {
  coalesceWatcherEvents,
  mapWatcherEventsToFsChangeEvents
} from './filesystem-watcher-event-normalization'

describe('filesystem watcher event normalization', () => {
  it('keeps delete before create but drops create before delete', () => {
    const events: WatcherEvent[] = [
      { type: 'delete', path: '/repo/a.ts' },
      { type: 'create', path: '/repo/a.ts' },
      { type: 'create', path: '/repo/temp.ts' },
      { type: 'delete', path: '/repo/temp.ts' }
    ]

    expect(coalesceWatcherEvents(events)).toEqual([
      { type: 'delete', path: '/repo/a.ts' },
      { type: 'create', path: '/repo/a.ts' }
    ])
  })

  it('does not stat delete events', async () => {
    vi.mocked(stat).mockResolvedValue({ isDirectory: () => false } as never)

    await expect(
      mapWatcherEventsToFsChangeEvents([{ type: 'delete', path: '/repo/a.ts' }])
    ).resolves.toEqual([{ kind: 'delete', absolutePath: '/repo/a.ts', isDirectory: undefined }])
    expect(stat).not.toHaveBeenCalled()
  })
})
