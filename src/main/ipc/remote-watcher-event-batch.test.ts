import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FsChangeEvent } from '../../shared/types'
import { createRemoteWatcherEventBatch } from './remote-watcher-event-batch'

const ROOT = '/home/u/repo'

function makeBatch(deliver: (events: FsChangeEvent[]) => void, maxEvents = 5_000) {
  return createRemoteWatcherEventBatch({
    rootPath: ROOT,
    deliver,
    trailingMs: 150,
    maxWaitMs: 500,
    maxEvents
  })
}

describe('createRemoteWatcherEventBatch', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('collapses many pushes inside the trailing window into one delivery', () => {
    const deliver = vi.fn()
    const batch = makeBatch(deliver)

    for (let i = 0; i < 50; i++) {
      batch.push([{ kind: 'update', absolutePath: `${ROOT}/file-${i}.ts` }])
      vi.advanceTimersByTime(1)
    }
    expect(deliver).not.toHaveBeenCalled()

    vi.advanceTimersByTime(150)
    expect(deliver).toHaveBeenCalledTimes(1)
    expect(deliver.mock.calls[0][0]).toHaveLength(50)
  })

  it('flushes at the max wait when pushes never stop', () => {
    const deliver = vi.fn()
    const batch = makeBatch(deliver)

    for (let i = 0; i < 10; i++) {
      batch.push([{ kind: 'update', absolutePath: `${ROOT}/a.ts` }])
      vi.advanceTimersByTime(100)
    }

    expect(deliver).toHaveBeenCalled()
    expect(deliver.mock.calls[0][0]).toEqual([{ kind: 'update', absolutePath: `${ROOT}/a.ts` }])
  })

  it('emits both events for delete then create, delete first', () => {
    const deliver = vi.fn()
    const batch = makeBatch(deliver)

    batch.push([
      { kind: 'delete', absolutePath: `${ROOT}/a.ts` },
      { kind: 'create', absolutePath: `${ROOT}/a.ts` }
    ])
    vi.advanceTimersByTime(150)

    expect(deliver.mock.calls[0][0]).toEqual([
      { kind: 'delete', absolutePath: `${ROOT}/a.ts` },
      { kind: 'create', absolutePath: `${ROOT}/a.ts` }
    ])
  })

  it('drops both events for create then delete', () => {
    const deliver = vi.fn()
    const batch = makeBatch(deliver)

    batch.push([
      { kind: 'create', absolutePath: `${ROOT}/tmp.ts` },
      { kind: 'delete', absolutePath: `${ROOT}/tmp.ts` }
    ])
    vi.advanceTimersByTime(150)

    expect(deliver).not.toHaveBeenCalled()
  })

  it('clears a stale delete when a later update is known to be a file', () => {
    const deliver = vi.fn()
    const batch = makeBatch(deliver)

    batch.push([
      { kind: 'delete', absolutePath: `${ROOT}/a.ts` },
      { kind: 'create', absolutePath: `${ROOT}/a.ts` },
      { kind: 'update', absolutePath: `${ROOT}/a.ts`, isDirectory: false }
    ])
    vi.advanceTimersByTime(150)

    expect(deliver.mock.calls[0][0]).toEqual([
      { kind: 'update', absolutePath: `${ROOT}/a.ts`, isDirectory: false }
    ])
  })

  it('keeps the delete when a later update has unknown isDirectory', () => {
    const deliver = vi.fn()
    const batch = makeBatch(deliver)

    batch.push([
      { kind: 'delete', absolutePath: `${ROOT}/dist` },
      { kind: 'create', absolutePath: `${ROOT}/dist` },
      { kind: 'update', absolutePath: `${ROOT}/dist` }
    ])
    vi.advanceTimersByTime(150)

    expect(deliver.mock.calls[0][0]).toEqual([
      { kind: 'delete', absolutePath: `${ROOT}/dist` },
      { kind: 'update', absolutePath: `${ROOT}/dist` }
    ])
  })

  it('emits the net delete for delete then create then delete', () => {
    const deliver = vi.fn()
    const batch = makeBatch(deliver)

    batch.push([
      { kind: 'delete', absolutePath: `${ROOT}/dist/app.js` },
      { kind: 'create', absolutePath: `${ROOT}/dist/app.js` },
      { kind: 'delete', absolutePath: `${ROOT}/dist/app.js` }
    ])
    vi.advanceTimersByTime(150)

    expect(deliver).toHaveBeenCalledTimes(1)
    expect(deliver.mock.calls[0][0]).toEqual([
      { kind: 'delete', absolutePath: `${ROOT}/dist/app.js` }
    ])
  })

  it('re-hoists the delete when the window ends on a recreate', () => {
    const deliver = vi.fn()
    const batch = makeBatch(deliver)

    batch.push([
      { kind: 'delete', absolutePath: `${ROOT}/a.ts` },
      { kind: 'create', absolutePath: `${ROOT}/a.ts` },
      { kind: 'delete', absolutePath: `${ROOT}/a.ts` },
      { kind: 'create', absolutePath: `${ROOT}/a.ts` }
    ])
    vi.advanceTimersByTime(150)

    expect(deliver.mock.calls[0][0]).toEqual([
      { kind: 'delete', absolutePath: `${ROOT}/a.ts` },
      { kind: 'create', absolutePath: `${ROOT}/a.ts` }
    ])
  })

  it('keeps only the last update for one path', () => {
    const deliver = vi.fn()
    const batch = makeBatch(deliver)

    batch.push([{ kind: 'update', absolutePath: `${ROOT}/a.ts`, isDirectory: false }])
    batch.push([{ kind: 'update', absolutePath: `${ROOT}/a.ts`, isDirectory: false }])
    vi.advanceTimersByTime(150)

    expect(deliver).toHaveBeenCalledTimes(1)
    expect(deliver.mock.calls[0][0]).toEqual([
      { kind: 'update', absolutePath: `${ROOT}/a.ts`, isDirectory: false }
    ])
  })

  it('discards the buffer and delivers one overflow when an overflow event arrives', () => {
    const deliver = vi.fn()
    const batch = makeBatch(deliver)

    batch.push([{ kind: 'update', absolutePath: `${ROOT}/a.ts` }])
    batch.push([{ kind: 'overflow', absolutePath: ROOT }])
    batch.push([{ kind: 'update', absolutePath: `${ROOT}/b.ts` }])
    vi.advanceTimersByTime(150)

    expect(deliver).toHaveBeenCalledTimes(1)
    expect(deliver.mock.calls[0][0]).toEqual([{ kind: 'overflow', absolutePath: ROOT }])
  })

  it('latches overflow once the accumulated batch exceeds maxEvents', () => {
    const deliver = vi.fn()
    const batch = makeBatch(deliver, 100)

    for (let i = 0; i < 3; i++) {
      batch.push(
        Array.from(
          { length: 50 },
          (_unused, index): FsChangeEvent => ({
            kind: 'update',
            absolutePath: `${ROOT}/wave-${i}-${index}.ts`
          })
        )
      )
    }
    vi.advanceTimersByTime(150)

    expect(deliver).toHaveBeenCalledTimes(1)
    expect(deliver.mock.calls[0][0]).toEqual([{ kind: 'overflow', absolutePath: ROOT }])
  })

  it('never invents isDirectory for events that arrive without it', () => {
    const deliver = vi.fn()
    const batch = makeBatch(deliver)

    batch.push([{ kind: 'create', absolutePath: `${ROOT}/dir` }])
    vi.advanceTimersByTime(150)

    const [delivered] = deliver.mock.calls[0][0] as FsChangeEvent[]
    expect(delivered.isDirectory).toBeUndefined()
    expect('isDirectory' in delivered).toBe(false)
  })

  it('passes an unknown kind through verbatim after the coalesced set', () => {
    const deliver = vi.fn()
    const batch = makeBatch(deliver)

    batch.push([
      { kind: 'rename', absolutePath: `${ROOT}/new.ts`, oldAbsolutePath: `${ROOT}/old.ts` },
      { kind: 'update', absolutePath: `${ROOT}/a.ts` }
    ])
    vi.advanceTimersByTime(150)

    expect(deliver.mock.calls[0][0]).toEqual([
      { kind: 'update', absolutePath: `${ROOT}/a.ts` },
      { kind: 'rename', absolutePath: `${ROOT}/new.ts`, oldAbsolutePath: `${ROOT}/old.ts` }
    ])
  })

  it('delivers nothing after close', () => {
    const deliver = vi.fn()
    const batch = makeBatch(deliver)

    batch.push([{ kind: 'update', absolutePath: `${ROOT}/a.ts` }])
    batch.close()
    vi.advanceTimersByTime(1_000)

    expect(deliver).not.toHaveBeenCalled()
  })

  it('ignores a push that lands after close instead of arming a timer', () => {
    const deliver = vi.fn()
    const batch = makeBatch(deliver)

    batch.close()
    batch.push([{ kind: 'update', absolutePath: `${ROOT}/a.ts` }])

    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(1_000)
    expect(deliver).not.toHaveBeenCalled()
  })

  // Why: the host platform is irrelevant — the coalesce key must stay shape-based, so a case-sensitive
  // remote pair must survive it on any host, and neither path may pick up drive/backslash rewriting.
  it('keeps case-distinct remote POSIX paths separate and byte-identical', () => {
    const deliver = vi.fn()
    const batch = makeBatch(deliver)

    batch.push([{ kind: 'update', absolutePath: '/home/u/A' }])
    batch.push([{ kind: 'update', absolutePath: '/home/u/a' }])
    vi.advanceTimersByTime(150)

    const delivered = deliver.mock.calls[0][0] as FsChangeEvent[]
    expect(delivered).toEqual([
      { kind: 'update', absolutePath: '/home/u/A' },
      { kind: 'update', absolutePath: '/home/u/a' }
    ])
    for (const event of delivered) {
      expect(event.absolutePath).not.toContain('\\')
      expect(event.absolutePath).not.toMatch(/^[a-zA-Z]:/)
    }
  })
})
