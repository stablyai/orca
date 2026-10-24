import { createWatcherSender } from './filesystem-watcher-test-sender'
/*
 * Real (unmocked) macOS FSEvents repro for a folder workspace that stops updating.
 *
 * Why: a folder workspace root like ~/github holds many repos, and FSEvents only
 * excludes `.git`/`node_modules` directly under the root. Churn in nested
 * `node_modules` still floods this client until FSEvents reports
 * MustScanSubDirs ("Events were dropped ... must be re-scanned"). The stream
 * keeps running, but the watcher used to treat that as a terminal error and
 * dropped the root for the rest of the app session.
 *
 * Opt-in (ORCA_FSEVENTS_STORM_REPRO=1) because it writes ~120k files and the
 * drop is load-dependent.
 */
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { subscribe, type AsyncSubscription } from '@parcel/watcher'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FsChangedPayload } from '../../shared/filesystem-entry-types'

const { handleMock } = vi.hoisted(() => ({ handleMock: vi.fn() }))

vi.mock('electron', () => ({
  ipcMain: { handle: handleMock }
}))

import { closeAllWatchers } from './filesystem-watcher-shutdown'
import { registerFilesystemWatcherHandlers } from './filesystem-watcher-handlers'
import { watcherLifecycleState } from './filesystem-watcher-lifecycle-state'
import { isParcelWatcherRescanRequiredError } from './parcel-watcher-rescan-error'

type HandlerMap = Record<string, (_event: unknown, args: unknown) => unknown>
type SendFsChanged = (channel: string, payload: FsChangedPayload) => void

const NESTED_REPOS = 16
const FILES_PER_REPO = 15_000
const STORM_ROUNDS = 3

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) {
      return true
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return predicate()
}

function writeEmptyFiles(dir: string, count: number): Promise<void> {
  // Why: a shell loop outruns Node's fs calls enough to overflow the FSEvents client queue.
  return new Promise((resolve, reject) => {
    const child = spawn('sh', [
      '-c',
      `mkdir -p "$0" && cd "$0" && i=0; while [ $i -lt ${count} ]; do : > f$i; i=$((i+1)); done`,
      dir
    ])
    child.on('error', reject)
    child.on('exit', () => resolve())
  })
}

describe.runIf(process.platform === 'darwin' && process.env.ORCA_FSEVENTS_STORM_REPRO === '1')(
  'filesystem-watcher FSEvents rescan recovery (real)',
  () => {
    const handlers: HandlerMap = {}
    let tempDir: string | null = null
    let probe: AsyncSubscription | null = null

    beforeEach(async () => {
      handleMock.mockReset()
      handleMock.mockImplementation((channel: string, handler: HandlerMap[string]) => {
        handlers[channel] = handler
      })
      registerFilesystemWatcherHandlers()
      await closeAllWatchers()
    })

    afterEach(async () => {
      await probe?.unsubscribe()
      probe = null
      await closeAllWatchers()
      if (tempDir) {
        await rm(tempDir, { recursive: true, force: true })
        tempDir = null
      }
      vi.clearAllMocks()
    })

    it('keeps reporting edits after nested node_modules churn makes FSEvents drop events', async () => {
      const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        tempDir = await realpath(await mkdtemp(join(tmpdir(), 'orca-fsevents-rescan-')))
        const nestedDirs = Array.from({ length: NESTED_REPOS }, (_, index) =>
          join(tempDir!, `repo-${index}`, 'node_modules')
        )
        await Promise.all(nestedDirs.map((dir) => mkdir(dir, { recursive: true })))
        const sendMock = vi.fn<SendFsChanged>()
        const sender = createWatcherSender(1, sendMock)
        await handlers['fs:watchWorktree']({ sender }, { worktreePath: tempDir })
        // Why: the Orca watcher runs in a child, so a probe client proves the storm hit MustScanSubDirs.
        let probeSawRescan = false
        probe = await subscribe(tempDir, (err) => {
          if (err && isParcelWatcherRescanRequiredError(err)) {
            probeSawRescan = true
          }
        })

        const sawDroppedEvents = (): boolean =>
          probeSawRescan &&
          sendMock.mock.calls.some(
            ([channel, payload]) =>
              channel === 'fs:changed' && payload.events.some((event) => event.kind === 'overflow')
          )
        // Why: the client-side drop depends on machine load, so storm again until FSEvents reports it.
        for (let round = 0; round < STORM_ROUNDS && !sawDroppedEvents(); round++) {
          await Promise.all(
            nestedDirs.map((dir) => writeEmptyFiles(join(dir, `round-${round}`), FILES_PER_REPO))
          )
          await waitFor(sawDroppedEvents, 5_000)
        }
        expect(sawDroppedEvents()).toBe(true)

        const notePath = join(tempDir, 'note.md')
        let delivered = false
        for (let attempt = 0; attempt < 8 && !delivered; attempt++) {
          await writeFile(notePath, `edit ${attempt}`)
          delivered = await waitFor(
            () =>
              sendMock.mock.calls.some(
                ([channel, payload]) =>
                  channel === 'fs:changed' &&
                  payload.events.some((event) => event.absolutePath === notePath)
              ),
            1_000
          )
        }

        expect(watcherLifecycleState.watchedRoots.has(tempDir)).toBe(true)
        expect(delivered).toBe(true)
        await handlers['fs:unwatchWorktree']({ sender: { id: 1 } }, { worktreePath: tempDir })
      } finally {
        errorLog.mockRestore()
      }
    }, 120_000)
  }
)
