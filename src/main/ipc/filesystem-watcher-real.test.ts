/*
 * Real (unmocked) @parcel/watcher integration test.
 *
 * Why: every other filesystem-watcher test mocks '@parcel/watcher', so the
 * suite stays green even when the native module is absent from the packaged
 * runtime — the exact failure behind the directory tree not auto-refreshing
 * (#4684; root cause #4851). A mocked subscribe() always "exists", so those
 * tests cannot see a missing-from-bundle watcher. This test loads the real
 * watcher, subscribes to a temp directory, mutates a file, and asserts a
 * 'fs:changed' event actually fires end-to-end. Only 'electron' is mocked
 * (it cannot load under vitest); the watcher itself is real.
 *
 * On a Linux host isWslPath() is always false, so a native /tmp path routes to
 * createWatcher() -> real @parcel/watcher (not the inotifywait WSL fallback).
 */
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { handleMock } = vi.hoisted(() => ({ handleMock: vi.fn() }))

vi.mock('electron', () => ({
  ipcMain: { handle: handleMock }
}))

import { closeAllWatchers, registerFilesystemWatcherHandlers } from './filesystem-watcher'
import {
  createAliasedWatcherRoot,
  removeAliasedWatcherRoot,
  type AliasedWatcherRoot
} from './watcher-aliased-root-fixture'

type HandlerMap = Record<string, (_event: unknown, args: unknown) => unknown>

type FsChangedCall = { worktreePath: string; events: { kind: string; absolutePath: string }[] }

// Why: real inotify + the 150ms trailing debounce means the event arrives
// asynchronously after the file write; poll rather than assume a fixed delay.
async function waitFor(predicate: () => boolean, timeoutMs = 8_000, stepMs = 50): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, stepMs))
  }
  throw new Error('waitFor: condition not met within timeout')
}

describe('filesystem-watcher real @parcel/watcher integration', () => {
  const handlers: HandlerMap = {}
  let tempDir: string | null = null
  let aliasedRoot: AliasedWatcherRoot | null = null

  beforeEach(async () => {
    handleMock.mockReset()
    for (const key of Object.keys(handlers)) {
      delete handlers[key]
    }
    handleMock.mockImplementation((channel: string, handler: HandlerMap[string]) => {
      handlers[channel] = handler
    })
    registerFilesystemWatcherHandlers()
    await closeAllWatchers()
  })

  afterEach(async () => {
    await closeAllWatchers()
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true })
      tempDir = null
    }
    await removeAliasedWatcherRoot(aliasedRoot)
    aliasedRoot = null
    vi.clearAllMocks()
  })

  // Why: a clear, separate failure mode — if the native addon is missing from
  // the bundle the watcher silently no-ops (doInstallLocalWatcher swallows the
  // import error), so the wiring assertion below would time out with a vague
  // message. This makes "addon absent" distinct from "wiring broken".
  it('loads the real @parcel/watcher native addon', async () => {
    const watcher = await import('@parcel/watcher')
    expect(typeof watcher.subscribe).toBe('function')
  })

  // Why: this integration targets the Linux native watcher path described
  // above; macOS developer sandboxes can load the addon while suppressing
  // subscribe callbacks, which makes this an environment check instead.
  it.runIf(process.platform === 'linux')(
    'emits fs:changed for a file created in a watched directory',
    async () => {
      // Why: macOS reports temp watcher events under /private/var while
      // tmpdir() returns /var, so compare canonical paths instead of aliases.
      tempDir = await realpath(await mkdtemp(join(tmpdir(), 'orca-fswatch-real-')))
      const sendMock = vi.fn()
      const sender = {
        isDestroyed: () => false,
        send: sendMock,
        once: vi.fn(),
        id: 1
      }

      // Subscribe resolves only after the native watcher is installed.
      await handlers['fs:watchWorktree']({ sender }, { worktreePath: tempDir })

      const createdFile = join(tempDir, 'new-file.txt')
      await writeFile(createdFile, 'hello')

      await waitFor(() =>
        sendMock.mock.calls.some(
          ([channel, payload]) =>
            channel === 'fs:changed' &&
            (payload as FsChangedCall).events.some((event) => event.absolutePath === createdFile)
        )
      )

      const changed = sendMock.mock.calls.find(([channel]) => channel === 'fs:changed')
      expect(changed).toBeDefined()
      const payload = changed![1] as FsChangedCall
      const event = payload.events.find((entry) => entry.absolutePath === createdFile)
      expect(event).toBeDefined()
      expect(['create', 'update']).toContain(event!.kind)

      await handlers['fs:unwatchWorktree']({ sender: { id: 1 } }, { worktreePath: tempDir })
    },
    15_000
  )

  // Why: this is the end-to-end repro, and it fails differently per platform
  // without the fix — Linux cannot inotify-watch the alias at all (IN_ONLYDIR),
  // macOS watches it but reports paths under the resolved root. Both leave the
  // renderer with events outside the root it subscribed with. One assertion
  // covers both: the emitted paths must stay under the subscribed spelling.
  it('reports events under an aliased worktree root, not its resolved path', async () => {
    const root = await createAliasedWatcherRoot('orca-fswatch-alias-')
    aliasedRoot = root
    await mkdir(join(root.realRoot, 'src'), { recursive: true })

    const sendMock = vi.fn()
    const sender = { isDestroyed: () => false, send: sendMock, once: vi.fn(), id: 1 }
    await handlers['fs:watchWorktree']({ sender }, { worktreePath: root.aliasRoot })

    const expectedPath = join(root.aliasRoot, 'src', 'agent-edit.ts')
    await writeFile(join(root.realRoot, 'src', 'agent-edit.ts'), 'hello')

    await waitFor(() =>
      sendMock.mock.calls.some(
        ([channel, payload]) =>
          channel === 'fs:changed' &&
          (payload as FsChangedCall).events.some((event) => event.absolutePath === expectedPath)
      )
    )

    await handlers['fs:unwatchWorktree']({ sender: { id: 1 } }, { worktreePath: root.aliasRoot })
  }, 15_000)
})
