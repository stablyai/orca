import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installFakeAppEnvironment } from '../../config/scripts/vitest-host-ports-setup'

let userDataDir: string

import { hashWorktreeId } from './terminal-history-paths'
import {
  deleteWorktreeHistoryDir,
  flushPendingWorktreeHistoryDeletions
} from './terminal-history-deletion'

describe('deleteWorktreeHistoryDir main-thread safety', () => {
  beforeEach(() => {
    userDataDir = mkdtempSync(join(tmpdir(), 'orca-history-async-'))
    installFakeAppEnvironment({ getPath: () => userDataDir })
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
    for (let i = 0; i < 3_000; i++) {
      writeFileSync(join(historyDir, `file-${i}.txt`), `payload-${i}`)
    }

    // Measure the sync delete call; later async-rm timer gaps depend on CI scheduling.
    const criticalPathStartedAt = performance.now()
    deleteWorktreeHistoryDir(worktreeId)
    const criticalPathMs = performance.now() - criticalPathStartedAt

    // AV/shared runners can delay rename; structural assertions below establish tombstoning.
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
    // Keep this removal in flight past the seed batch.
    for (let i = 0; i < 3_000; i++) {
      writeFileSync(join(lateDir, `file-${i}.txt`), `payload-${i}`)
    }

    deleteWorktreeHistoryDir('repo-1::/path/seed-wt')
    // Schedule the second delete outside the flush's initial snapshot, without yielding first.
    const flushed = flushPendingWorktreeHistoryDeletions()
    deleteWorktreeHistoryDir(lateWorktreeId)
    await flushed

    expect(readdirSync(join(userDataDir, 'terminal-history', '.pending-delete'))).toHaveLength(0)
  })
})
