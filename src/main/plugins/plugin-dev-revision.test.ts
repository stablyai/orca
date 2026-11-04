import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { PluginDevWatcher } from './plugin-dev-watcher'
import {
  bumpPluginDevRevision,
  pluginDevChangeCount,
  pluginDevRevision
} from './plugin-dev-revision'
import type { subscribeViaWatcherProcess } from '../ipc/filesystem/watcher-process/parcel-watcher-process'

type Callback = Parameters<typeof subscribeViaWatcherProcess>[1]

describe('plugin dev revision', () => {
  it('counts per root, under any spelling of the path', () => {
    const root = join(tmpdir(), 'orca-dev-revision-a')
    const before = pluginDevRevision(root)
    expect(before).toMatch(/^dev-[0-9a-f]{8}-\d+$/)
    bumpPluginDevRevision(`${root}/./`)
    expect(pluginDevRevision(root)).not.toBe(before)
    expect(pluginDevRevision(join(tmpdir(), 'orca-dev-revision-b'))).toMatch(/-0$/)
  })

  it('is bumped by the dev watcher for each change it reports under the root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-dev-revision-watch-'))
    const callbacks = new Map<string, Callback>()
    const subscribe = vi.fn(async (path: string, callback: Callback) => {
      callbacks.set(path, callback)
      return { unsubscribe: async () => {} }
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the watcher uses only the callback and unsubscribe of what the fake returns.
    const watcher = new PluginDevWatcher(subscribe as never)
    watcher.start([root], () => {})
    await vi.waitFor(() => expect(callbacks.has(root)).toBe(true))
    const subscribed = pluginDevRevision(root)
    callbacks.get(root)?.(null, [{ type: 'update', path: join(root, 'panel.js') }])
    expect(pluginDevRevision(root)).not.toBe(subscribed)
    watcher.dispose()
  })

  it('counts changed files from watcher events but not setup catch-ups', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-dev-change-count-'))
    const callbacks = new Map<string, Callback>()
    const subscribe = vi.fn(async (path: string, callback: Callback) => {
      callbacks.set(path, callback)
      return { unsubscribe: async () => {} }
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the watcher uses only the callback and unsubscribe of what the fake returns.
    const watcher = new PluginDevWatcher(subscribe as never)
    watcher.start([root], () => {})
    await vi.waitFor(() => expect(callbacks.has(root)).toBe(true))
    expect(pluginDevChangeCount(root)).toBe(0)
    callbacks.get(root)?.(null, [
      { type: 'update', path: join(root, 'panel.tsx') },
      { type: 'update', path: join(root, 'panel.tsx') },
      { type: 'create', path: join(root, 'style.css') }
    ])
    expect(pluginDevChangeCount(root)).toBe(2)
    watcher.dispose()
  })
})
