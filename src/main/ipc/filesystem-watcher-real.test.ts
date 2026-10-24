import { createWatcherSender } from './filesystem-watcher-test-sender'
/* Use the real native watcher to catch missing packaged addons and verify end-to-end delivery (#4684, #4851). */
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { handleMock } = vi.hoisted(() => ({ handleMock: vi.fn() }))

vi.mock('electron', () => ({
  ipcMain: { handle: handleMock }
}))

import { closeAllWatchers } from './filesystem-watcher-shutdown'
import { registerFilesystemWatcherHandlers } from './filesystem-watcher-handlers'
import {
  createAliasedWatcherRoot,
  removeAliasedWatcherRoot,
  type AliasedWatcherRoot
} from './watcher-aliased-root-fixture'

type HandlerMap = Record<string, (_event: unknown, args: unknown) => unknown>

type FsChangedCall = { worktreePath: string; events: { kind: string; absolutePath: string }[] }

// Poll native delivery and batching rather than assuming a fixed delay.
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

  // Target Linux native delivery; macOS sandboxes can suppress callbacks despite loading the addon.
  it.runIf(process.platform === 'linux')(
    'emits fs:changed for a file created in a watched directory',
    async () => {
      // Canonicalize macOS /var temp aliases before comparing event paths.
      tempDir = await realpath(await mkdtemp(join(tmpdir(), 'orca-fswatch-real-')))
      const sendMock = vi.fn()
      const sender = createWatcherSender(1, sendMock)

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

  // Alias watchers must preserve subscribed path spelling even when native events report resolved roots.
  it('reports events under an aliased worktree root, not its resolved path', async () => {
    const root = await createAliasedWatcherRoot('orca-fswatch-alias-')
    aliasedRoot = root
    await mkdir(join(root.realRoot, 'src'), { recursive: true })

    const sendMock = vi.fn()
    const sender = createWatcherSender(1, sendMock)
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
