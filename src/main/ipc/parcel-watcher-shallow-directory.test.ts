import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type * as Fs from 'node:fs'
import { startShallowWatcher } from './parcel-watcher-shallow-subscription'

const callbacks = vi.hoisted(() => new Map<string, (event: string, name: string | null) => void>())
class WatchHandle extends EventEmitter {
  close(): void {
    this.emit('close')
  }
}
vi.mock('node:fs', async () => ({
  ...(await vi.importActual<typeof Fs>('node:fs')),
  statSync: vi.fn(() => ({ dev: 1n, ino: 2n, isDirectory: () => true })),
  watch: vi.fn(
    (path: string, _options: unknown, callback: (event: string, name: string | null) => void) => {
      callbacks.set(path, callback)
      return new WatchHandle()
    }
  )
}))

const subscriptions: ReturnType<typeof startShallowWatcher>[] = []
beforeEach(() => callbacks.clear())
afterEach(async () => {
  await Promise.all(subscriptions.splice(0).map((subscription) => subscription.unsubscribe()))
})

it('watches direct entries without subscribing to descendants or enumerating them', () => {
  const events = vi.fn()
  subscriptions.push(startShallowWatcher('/root', [], events, vi.fn()))
  expect([...callbacks.keys()]).toEqual(['/root'])
  callbacks.get('/root')?.('change', 'notes.md')
  expect(events).toHaveBeenCalledExactlyOnceWith([
    { type: 'update', path: join('/root', 'notes.md') }
  ])
  callbacks.get('/root')?.('change', 'nested')
  expect([...callbacks.keys()]).toEqual(['/root'])
})

it('marks an unknown filename as a root resync without inventing a file path', () => {
  const events = vi.fn()
  subscriptions.push(startShallowWatcher('/root', [], events, vi.fn()))
  callbacks.get('/root')?.('change', null)
  expect(events).toHaveBeenCalledExactlyOnceWith([{ type: 'update', path: '/root' }])
})

it('keeps include-list subscriptions restricted to their existing file names', () => {
  const events = vi.fn()
  subscriptions.push(startShallowWatcher('/root', ['HEAD'], events, vi.fn()))
  callbacks.get('/root')?.('change', 'notes.md')
  expect(events).not.toHaveBeenCalled()
  callbacks.get('/root')?.('change', 'HEAD')
  expect(events).toHaveBeenCalledExactlyOnceWith([{ type: 'update', path: join('/root', 'HEAD') }])
})
