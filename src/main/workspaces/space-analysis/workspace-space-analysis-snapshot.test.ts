import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  WorkspaceSpaceAnalysis,
  WorkspaceSpaceWorktree
} from '../../../shared/workspace-disk-space/workspace-space-types'

const { snapshotWriteSpy, userDataDirHolder } = vi.hoisted(() => ({
  snapshotWriteSpy: vi.fn(),
  userDataDirHolder: { dir: '' }
}))

vi.mock('../../filesystem/sidecar-snapshot-file', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  const writeSidecarSnapshot = actual.writeSidecarSnapshot as (
    file: string,
    payload: unknown
  ) => Promise<void>
  return {
    ...actual,
    writeSidecarSnapshot: async (file: string, payload: unknown) => {
      snapshotWriteSpy(file, payload)
      await writeSidecarSnapshot(file, payload)
    }
  }
})

import {
  finalizeWorkspaceSpaceAnalysisSnapshotPrunes,
  persistWorkspaceSpaceAnalysisSnapshot,
  pruneWorkspaceSpaceAnalysisSnapshots,
  readWorkspaceSpaceAnalysisSnapshot,
  registerWorkspaceSpaceAnalysisSnapshotPruneTombstones
} from './workspace-space-analysis-snapshot'

const SNAPSHOT_FILE = 'orca-workspace-space-analysis.json'
const NOW = 1_700_000_000_000

function makeWorktreeRow(overrides: Partial<WorkspaceSpaceWorktree> = {}): WorkspaceSpaceWorktree {
  return {
    worktreeId: 'repo-1::/repo-feature',
    repoId: 'repo-1',
    executionHostId: 'local',
    repoDisplayName: 'Repo',
    repoPath: '/repo',
    displayName: 'Feature',
    path: '/repo-feature',
    branch: 'feature',
    isMainWorktree: false,
    isRemote: false,
    isSparse: false,
    canDelete: true,
    lastActivityAt: NOW - 1000,
    status: 'ok',
    error: null,
    scannedAt: NOW,
    sizeBytes: 1000,
    reclaimableBytes: 1000,
    skippedEntryCount: 0,
    topLevelItems: [],
    omittedTopLevelItemCount: 0,
    omittedTopLevelSizeBytes: 0,
    ...overrides
  }
}

function makeAnalysis(worktrees: WorkspaceSpaceWorktree[]): WorkspaceSpaceAnalysis {
  const okRows = worktrees.filter((row) => row.status === 'ok')
  const rowsByHost = Map.groupBy(worktrees, (row) => row.executionHostId ?? 'local')
  return {
    scannedAt: NOW,
    totalSizeBytes: worktrees.reduce((sum, row) => sum + row.sizeBytes, 0),
    reclaimableBytes: worktrees.reduce((sum, row) => sum + row.reclaimableBytes, 0),
    worktreeCount: worktrees.length,
    scannedWorktreeCount: okRows.length,
    unavailableWorktreeCount: worktrees.length - okRows.length,
    repos: [...rowsByHost.entries()].map(([executionHostId, rows]) => {
      const scanned = rows.filter((row) => row.status === 'ok')
      return {
        repoId: 'repo-1',
        executionHostId,
        displayName: 'Repo',
        path: '/repo',
        isRemote: executionHostId !== 'local',
        worktreeCount: rows.length,
        scannedWorktreeCount: scanned.length,
        unavailableWorktreeCount: rows.length - scanned.length,
        totalSizeBytes: rows.reduce((sum, row) => sum + row.sizeBytes, 0),
        reclaimableBytes: rows.reduce((sum, row) => sum + row.reclaimableBytes, 0),
        error: null
      }
    }),
    worktrees
  }
}

describe('workspace space analysis snapshot', () => {
  beforeEach(async () => {
    snapshotWriteSpy.mockClear()
    userDataDirHolder.dir = await mkdtemp(join(tmpdir(), 'orca-space-snapshot-'))
  })

  afterEach(async () => {
    await rm(userDataDirHolder.dir, { recursive: true, force: true })
  })

  it('returns null when missing or corrupt instead of throwing', async () => {
    await expect(readWorkspaceSpaceAnalysisSnapshot(userDataDirHolder.dir)).resolves.toBeNull()

    const file = join(userDataDirHolder.dir, SNAPSHOT_FILE)
    await writeFile(file, '{"version":1,"analysis":', 'utf-8')
    await expect(readWorkspaceSpaceAnalysisSnapshot(userDataDirHolder.dir)).resolves.toBeNull()

    await writeFile(
      file,
      JSON.stringify({
        version: 2,
        analysis: { scannedAt: 'yesterday', repos: [], worktrees: [] }
      }),
      'utf-8'
    )
    await expect(readWorkspaceSpaceAnalysisSnapshot(userDataDirHolder.dir)).resolves.toBeNull()

    await writeFile(
      file,
      JSON.stringify({ version: 99, analysis: makeAnalysis([makeWorktreeRow()]) }),
      'utf-8'
    )
    await expect(readWorkspaceSpaceAnalysisSnapshot(userDataDirHolder.dir)).resolves.toBeNull()
  })

  it('coalesces local and remote row rebalancing into one write', async () => {
    const localCollision = makeWorktreeRow({ sizeBytes: 1000, reclaimableBytes: 1000 })
    const remoteCollision = makeWorktreeRow({
      executionHostId: 'ssh:ssh-1',
      isRemote: true,
      sizeBytes: 2000,
      reclaimableBytes: 2000
    })
    const localRemoved = makeWorktreeRow({
      worktreeId: 'repo-1::/local-removed',
      path: '/local-removed',
      status: 'missing',
      sizeBytes: 3000,
      reclaimableBytes: 0
    })
    const remoteRemoved = makeWorktreeRow({
      worktreeId: 'repo-1::/remote-removed',
      executionHostId: 'ssh:ssh-1',
      isRemote: true,
      path: '/remote-removed',
      sizeBytes: 4000,
      reclaimableBytes: 4000
    })
    const kept = makeWorktreeRow({
      worktreeId: 'repo-1::/kept',
      path: '/kept',
      sizeBytes: 500,
      reclaimableBytes: 500
    })
    await persistWorkspaceSpaceAnalysisSnapshot(
      userDataDirHolder.dir,
      makeAnalysis([localCollision, remoteCollision, localRemoved, remoteRemoved, kept])
    )

    snapshotWriteSpy.mockClear()
    await pruneWorkspaceSpaceAnalysisSnapshots(userDataDirHolder.dir, [
      { worktreeId: localCollision.worktreeId, executionHostId: 'local' },
      { worktreeId: localRemoved.worktreeId, executionHostId: 'local' },
      { worktreeId: remoteRemoved.worktreeId, executionHostId: 'ssh:ssh-1' }
    ])

    expect(snapshotWriteSpy).toHaveBeenCalledTimes(1)
    expect(snapshotWriteSpy).toHaveBeenCalledWith(
      join(userDataDirHolder.dir, SNAPSHOT_FILE),
      expect.objectContaining({
        analysis: expect.objectContaining({
          worktrees: [remoteCollision, kept],
          worktreeCount: 2,
          scannedWorktreeCount: 2,
          unavailableWorktreeCount: 0,
          totalSizeBytes: 2500,
          reclaimableBytes: 2500
        })
      })
    )
    const cached = await readWorkspaceSpaceAnalysisSnapshot(userDataDirHolder.dir)
    expect(cached?.repos).toEqual([
      expect.objectContaining({ executionHostId: 'local', worktreeCount: 1, totalSizeBytes: 500 }),
      expect.objectContaining({
        executionHostId: 'ssh:ssh-1',
        worktreeCount: 1,
        totalSizeBytes: 2000
      })
    ])

    snapshotWriteSpy.mockClear()
    await pruneWorkspaceSpaceAnalysisSnapshots(userDataDirHolder.dir, [
      { worktreeId: 'repo-1::/missing-local', executionHostId: 'local' },
      { worktreeId: 'repo-1::/missing-remote', executionHostId: 'ssh:ssh-1' }
    ])
    expect(snapshotWriteSpy).not.toHaveBeenCalled()
  })

  it('does not let an analysis started before bulk removal restore pruned rows', async () => {
    const local = makeWorktreeRow()
    const remote = makeWorktreeRow({
      worktreeId: 'repo-1::/remote-feature',
      executionHostId: 'ssh:ssh-1',
      isRemote: true,
      path: '/remote-feature'
    })
    const staleAnalysis = {
      ...makeAnalysis([local, remote]),
      scannedAt: Date.now() - 1
    }
    await pruneWorkspaceSpaceAnalysisSnapshots(userDataDirHolder.dir, [
      { worktreeId: local.worktreeId, executionHostId: 'local' },
      { worktreeId: remote.worktreeId, executionHostId: 'ssh:ssh-1' }
    ])

    await persistWorkspaceSpaceAnalysisSnapshot(userDataDirHolder.dir, staleAnalysis)
    expect((await readWorkspaceSpaceAnalysisSnapshot(userDataDirHolder.dir))?.worktrees).toEqual([])

    const recreated = { ...staleAnalysis, scannedAt: Date.now() + 1 }
    await persistWorkspaceSpaceAnalysisSnapshot(userDataDirHolder.dir, recreated)
    expect((await readWorkspaceSpaceAnalysisSnapshot(userDataDirHolder.dir))?.worktrees).toEqual([
      local,
      remote
    ])
  })

  it('keeps the original tombstone time when a removal batch flushes', async () => {
    const row = makeWorktreeRow()
    const target = { worktreeId: row.worktreeId, executionHostId: 'local' as const }
    const now = vi.spyOn(Date, 'now').mockReturnValue(100)
    registerWorkspaceSpaceAnalysisSnapshotPruneTombstones(userDataDirHolder.dir, [target])
    now.mockReturnValue(200)

    await finalizeWorkspaceSpaceAnalysisSnapshotPrunes(userDataDirHolder.dir, [target])
    await persistWorkspaceSpaceAnalysisSnapshot(userDataDirHolder.dir, {
      ...makeAnalysis([row]),
      scannedAt: 150
    })

    expect((await readWorkspaceSpaceAnalysisSnapshot(userDataDirHolder.dir))?.worktrees).toEqual([
      { ...row, topLevelItems: [] }
    ])
    now.mockRestore()
  })
})
