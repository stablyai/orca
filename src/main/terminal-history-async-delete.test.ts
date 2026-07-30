import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let userDataDir: string

vi.mock('electron', () => ({
  app: {
    getPath: () => userDataDir
  }
}))

import { hashWorktreeId } from './terminal-history-paths'
import {
  deleteWorktreeHistoryDir,
  flushPendingWorktreeHistoryDeletions
} from './terminal-history-deletion'

/**
 * Prove worktree history delete stays off the main-thread recursive-rm path: the critical path only
 * tombstones, and the async rm finishes afterwards.
 */
describe('deleteWorktreeHistoryDir main-thread safety', () => {
  beforeEach(() => {
    userDataDir = mkdtempSync(join(tmpdir(), 'orca-history-async-'))
  })

  afterEach(async () => {
    await flushPendingWorktreeHistoryDeletions()
    rmSync(userDataDir, { recursive: true, force: true })
  })

  it('tombstones without blocking the event loop, then removes via async rm', async () => {
    const worktreeId = 'repo-1::/path/heavy-wt'
    const hash = hashWorktreeId(worktreeId)
    const historyDir = join(userDataDir, 'terminal-history', hash)
    mkdirSync(historyDir, { recursive: true })
    // Enough files that a recursive sync walk would dominate the critical-path duration.
    for (let i = 0; i < 3_000; i++) {
      writeFileSync(join(historyDir, `file-${i}.txt`), `payload-${i}`)
    }

    // Why critical-path wall time, not setInterval gaps: deleteWorktreeHistoryDir is sync and must
    // only rename. Interval gaps during the later async rm spike under CI scheduling (~50ms) even
    // when the critical path is fine; a recursive sync walk of 3k files is still hundreds of ms.
    const criticalPathStartedAt = performance.now()
    deleteWorktreeHistoryDir(worktreeId)
    const criticalPathMs = performance.now() - criticalPathStartedAt

    // Why a looser CI/Windows bound: a rename is O(1) metadata everywhere, but AV and shared CI runners
    // stall even that. The structural assertions below are the real proof; this only catches a sync walk.
    expect(criticalPathMs).toBeLessThan(
      process.env.CI || process.platform === 'win32' ? 1_000 : 100
    )
    expect(readdirSync(join(userDataDir, 'terminal-history'))).not.toContain(hash)
    expect(
      readdirSync(join(userDataDir, 'terminal-history', '.pending-delete')).length
    ).toBeGreaterThan(0)

    await flushPendingWorktreeHistoryDeletions()
    expect(readdirSync(join(userDataDir, 'terminal-history', '.pending-delete'))).toHaveLength(0)
  })

  it('drains a deletion scheduled after the flush snapshotted its batch', async () => {
    const seedDir = join(userDataDir, 'terminal-history', hashWorktreeId('repo-1::/path/seed-wt'))
    mkdirSync(seedDir, { recursive: true })
    writeFileSync(join(seedDir, 'seed.txt'), 'seed')

    const lateWorktreeId = 'repo-1::/path/late-wt'
    const lateDir = join(userDataDir, 'terminal-history', hashWorktreeId(lateWorktreeId))
    mkdirSync(lateDir, { recursive: true })
    // Big enough that its rm is still in flight when the snapshotted seed removal settles.
    for (let i = 0; i < 3_000; i++) {
      writeFileSync(join(lateDir, `file-${i}.txt`), `payload-${i}`)
    }

    deleteWorktreeHistoryDir('repo-1::/path/seed-wt')
    // Why no await before the second delete: the flush snapshots the pending map synchronously, so
    // this schedules the late removal outside that batch — exactly the race the drain loop covers.
    const flushed = flushPendingWorktreeHistoryDeletions()
    deleteWorktreeHistoryDir(lateWorktreeId)
    await flushed

    expect(readdirSync(join(userDataDir, 'terminal-history', '.pending-delete'))).toHaveLength(0)
  })
})
