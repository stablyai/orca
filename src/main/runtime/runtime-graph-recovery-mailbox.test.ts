import { rmSync } from 'node:fs'
import { afterEach, expect, it, vi } from 'vitest'
import {
  createDatabase,
  createRuntime,
  createBoundRun,
  insertDirectRunMessage,
  driveToLiveIdle,
  pointerCount,
  temporaryDirectories,
  TAB_ID,
  LEAF_ID,
  PTY_ID,
  WORKTREE_ID
} from './orchestration-mailbox-notification-test-harness'

afterEach(() => {
  vi.useRealTimers()
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

it('offers pending mailbox work to its existing owner when current graph publication recovers', async () => {
  vi.useFakeTimers()
  const db = createDatabase('orca-graph-recovery-mailbox-')
  try {
    const { runtime, write } = createRuntime(db)
    const publication = {
      rendererGeneration: 'mailbox-document',
      tabs: [
        {
          tabId: TAB_ID,
          worktreeId: WORKTREE_ID,
          title: 'Codex',
          activeLeafId: LEAF_ID,
          layout: null
        }
      ],
      leaves: [
        { tabId: TAB_ID, worktreeId: WORKTREE_ID, leafId: LEAF_ID, paneRuntimeId: 1, ptyId: PTY_ID }
      ]
    }
    runtime.syncWindowGraph(1, publication)
    const run = createBoundRun(db, 'Graph recovery')
    await driveToLiveIdle(runtime)
    runtime.markGraphReloadFailed(1, 'renderer-frame-unavailable')
    insertDirectRunMessage(db, run.id, 'Queued while graph unavailable')
    expect(pointerCount(write)).toBe(0)
    runtime.syncWindowGraph(1, publication)
    await vi.advanceTimersByTimeAsync(500)
    expect(pointerCount(write)).toBe(1)
    runtime.syncWindowGraph(1, publication)
    await vi.advanceTimersByTimeAsync(500)
    expect(pointerCount(write)).toBe(1)
  } finally {
    db.close()
  }
})
