/*
 * macOS FSEvents reports OS-canonical paths (symlinks resolved, on-disk
 * casing). Before the rewrite at the watcher boundary those events reached the
 * renderer spelled differently from the root it subscribed with, so every
 * consumer that derives a worktree-relative path silently dropped them — an
 * agent's edit never reloaded the open editor tab.
 */
import type * as NodeFs from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { handleMock, realpathMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  realpathMock: vi.fn()
}))

vi.mock('electron', () => ({ ipcMain: { handle: handleMock } }))

vi.mock('fs/promises', () => ({
  stat: vi.fn()
}))

vi.mock('node:fs', async (importOriginal) => {
  // Why: the supervisor resolves the watched root synchronously, so the fake
  // symlink target has to come from realpathSync rather than fs/promises.
  const actual = await importOriginal<typeof NodeFs>()
  return { ...actual, realpathSync: Object.assign(realpathMock, { native: realpathMock }) }
})

vi.mock('@parcel/watcher', () => ({ subscribe: vi.fn() }))

vi.mock('./filesystem-watcher-wsl', () => ({ createWslWatcher: vi.fn() }))

vi.mock('../providers/ssh-filesystem-dispatch', () => ({
  getSshFilesystemProvider: vi.fn(),
  onSshFilesystemProviderRegistered: () => () => {}
}))

import { closeAllWatchers, registerFilesystemWatcherHandlers } from './filesystem-watcher'
import { stat } from 'node:fs/promises'
import { subscribe as subscribeParcelWatcher } from '@parcel/watcher'
import type { Event as WatcherEvent } from '@parcel/watcher'
import type { FsChangedPayload } from '../../shared/filesystem-entry-types'
import { WATCH_BATCH_TRAILING_MS } from '../../shared/filesystem-watch-batch-window'

type HandlerMap = Record<string, (_event: unknown, args: unknown) => unknown>

describe('local filesystem watcher canonical root paths', () => {
  const handlers: HandlerMap = {}

  beforeEach(async () => {
    vi.useRealTimers()
    handleMock.mockReset()
    realpathMock.mockReset()
    vi.mocked(stat).mockReset()
    vi.mocked(subscribeParcelWatcher).mockReset()
    for (const key of Object.keys(handlers)) {
      delete handlers[key]
    }
    handleMock.mockImplementation((channel, handler) => {
      handlers[channel] = handler
    })
    registerFilesystemWatcherHandlers()
    await closeAllWatchers()
  })

  async function emitAndCapture(
    worktreePath: string,
    canonicalRoot: string,
    events: WatcherEvent[]
  ): Promise<FsChangedPayload> {
    // The root must stat as a directory to install; the event paths must not.
    vi.mocked(stat).mockImplementation(
      (candidate) => Promise.resolve({ isDirectory: () => candidate === worktreePath }) as never
    )
    realpathMock.mockReturnValue(canonicalRoot)
    let watcherCallback: ((err: Error | null, events: WatcherEvent[]) => void) | undefined
    vi.mocked(subscribeParcelWatcher).mockImplementation(async (_root, callback) => {
      watcherCallback = callback as typeof watcherCallback
      return { unsubscribe: vi.fn() } as never
    })
    const sendMock = vi.fn()
    const sender = { isDestroyed: () => false, send: sendMock, once: vi.fn(), id: 1 }
    await handlers['fs:watchWorktree']({ sender }, { worktreePath })
    watcherCallback!(null, events)
    await vi.waitFor(
      () => {
        expect(sendMock).toHaveBeenCalledWith('fs:changed', expect.anything())
      },
      { timeout: WATCH_BATCH_TRAILING_MS + 2_000 }
    )
    return sendMock.mock.calls.find(([channel]) => channel === 'fs:changed')![1] as FsChangedPayload
  }

  it('reports symlink-resolved event paths under the subscribed root', async () => {
    const worktreePath = resolve('/tmp/orca-link')
    const payload = await emitAndCapture(worktreePath, resolve('/private/tmp/orca-real'), [
      { path: resolve('/private/tmp/orca-real/src/agent-edit.ts'), type: 'update' }
    ])

    expect(payload.worktreePath).toBe(worktreePath)
    expect(payload.events).toEqual([
      {
        kind: 'update',
        absolutePath: resolve('/tmp/orca-link/src/agent-edit.ts'),
        isDirectory: false
      }
    ])
  })

  it.runIf(process.platform === 'darwin' || process.platform === 'win32')(
    'reports on-disk casing under the subscribed spelling',
    async () => {
      const worktreePath = resolve('/tmp/orca-case/repo')
      const payload = await emitAndCapture(worktreePath, worktreePath, [
        { path: resolve('/tmp/orca-case/Repo/src/agent-edit.ts'), type: 'update' }
      ])

      expect(payload.events[0]!.absolutePath).toBe(resolve('/tmp/orca-case/repo/src/agent-edit.ts'))
    }
  )

  it('leaves already-matching event paths untouched', async () => {
    const worktreePath = resolve('/tmp/orca-plain')
    const eventPath = resolve('/tmp/orca-plain/src/agent-edit.ts')
    const payload = await emitAndCapture(worktreePath, worktreePath, [
      { path: eventPath, type: 'update' }
    ])

    expect(payload.events[0]!.absolutePath).toBe(eventPath)
  })
})
