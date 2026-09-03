import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  WorkspaceSpaceAnalysis,
  WorkspaceSpaceWorktree
} from '../shared/workspace-space-types'

const { snapshotWriteSpy, userDataDirHolder } = vi.hoisted(() => ({
  snapshotWriteSpy: vi.fn(),
  userDataDirHolder: { dir: '' }
}))

vi.mock('./sidecar-snapshot-file', async (importOriginal) => {
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
  pruneWorkspaceSpaceAnalysisSnapshot,
  pruneWorkspaceSpaceAnalysisSnapshots,
  readWorkspaceSpaceAnalysisSnapshot,
  registerWorkspaceSpaceAnalysisSnapshotPruneTombstones,
  withWorkspaceSpaceAnalysisSnapshotProducer,
  workspaceSpaceAnalysisSnapshotTombstoneCountForTests
} from './workspace-space-analysis-snapshot'
import { WORKSPACE_SNAPSHOT_PRUNE_PRODUCER_TIMEOUT_MS } from './workspace-snapshot-prune-index'
import { openWorkspaceSnapshotPruneProducer } from './workspace-snapshot-prune-producer-fixtures'

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

/** An analysis whose fence opens at persist time — one that raced no removal. */
function persistAnalysis(
  snapshotDirectory: string,
  analysis: WorkspaceSpaceAnalysis
): Promise<void> {
  return withWorkspaceSpaceAnalysisSnapshotProducer(snapshotDirectory, (producer) =>
    persistWorkspaceSpaceAnalysisSnapshot(snapshotDirectory, analysis, producer)
  )
}

const openAnalysis = (
  snapshotDirectory: string
): ReturnType<typeof openWorkspaceSnapshotPruneProducer> =>
  openWorkspaceSnapshotPruneProducer(withWorkspaceSpaceAnalysisSnapshotProducer, snapshotDirectory)

describe('workspace space analysis snapshot', () => {
  beforeEach(async () => {
    snapshotWriteSpy.mockClear()
    userDataDirHolder.dir = await mkdtemp(join(tmpdir(), 'orca-space-snapshot-'))
  })

  afterEach(async () => {
    await rm(userDataDirHolder.dir, { recursive: true, force: true })
  })

  it('round-trips a completed analysis', async () => {
    const analysis = makeAnalysis([makeWorktreeRow()])

    await persistAnalysis(userDataDirHolder.dir, analysis)

    await expect(readWorkspaceSpaceAnalysisSnapshot(userDataDirHolder.dir)).resolves.toEqual(
      analysis
    )
  })

  it('prunes topLevelItems into the omitted counters to bound the payload', async () => {
    const row = makeWorktreeRow({
      sizeBytes: 5000,
      topLevelItems: [
        {
          name: 'node_modules',
          path: '/repo-feature/node_modules',
          kind: 'directory',
          sizeBytes: 3000
        },
        { name: 'src', path: '/repo-feature/src', kind: 'directory', sizeBytes: 1000 }
      ],
      omittedTopLevelItemCount: 2,
      omittedTopLevelSizeBytes: 500
    })

    await persistAnalysis(userDataDirHolder.dir, makeAnalysis([row]))

    const cached = await readWorkspaceSpaceAnalysisSnapshot(userDataDirHolder.dir)
    expect(cached?.worktrees[0]).toMatchObject({
      sizeBytes: 5000,
      topLevelItems: [],
      omittedTopLevelItemCount: 4,
      omittedTopLevelSizeBytes: 4500
    })
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

  it('loads legacy rows without an execution host id', async () => {
    const { executionHostId: _executionHostId, ...legacyRow } = makeWorktreeRow()
    const analysis = makeAnalysis([makeWorktreeRow()])
    await writeFile(
      join(userDataDirHolder.dir, SNAPSHOT_FILE),
      JSON.stringify({
        version: 2,
        analysis: { ...analysis, worktrees: [legacyRow] }
      }),
      'utf-8'
    )

    await expect(readWorkspaceSpaceAnalysisSnapshot(userDataDirHolder.dir)).resolves.toMatchObject({
      worktrees: [expect.objectContaining({ worktreeId: legacyRow.worktreeId })]
    })
  })

  it('prunes a removed worktree row and rebalances totals', async () => {
    const removed = makeWorktreeRow({ sizeBytes: 3000, reclaimableBytes: 3000 })
    const kept = makeWorktreeRow({
      worktreeId: 'repo-1::/repo-kept',
      path: '/repo-kept',
      status: 'missing',
      sizeBytes: 1000,
      reclaimableBytes: 0
    })
    await persistAnalysis(userDataDirHolder.dir, makeAnalysis([removed, kept]))

    snapshotWriteSpy.mockClear()
    await pruneWorkspaceSpaceAnalysisSnapshot(userDataDirHolder.dir, removed.worktreeId, 'local')

    const cached = await readWorkspaceSpaceAnalysisSnapshot(userDataDirHolder.dir)
    expect(cached?.worktrees.map((row) => row.worktreeId)).toEqual(['repo-1::/repo-kept'])
    expect(cached).toMatchObject({
      worktreeCount: 1,
      scannedWorktreeCount: 0,
      unavailableWorktreeCount: 1,
      totalSizeBytes: 1000,
      reclaimableBytes: 0
    })
    expect(cached?.repos[0]).toMatchObject({
      worktreeCount: 1,
      scannedWorktreeCount: 0,
      unavailableWorktreeCount: 1,
      totalSizeBytes: 1000,
      reclaimableBytes: 0
    })
    expect(snapshotWriteSpy).toHaveBeenCalledTimes(1)

    // Unknown ids are a no-op.
    snapshotWriteSpy.mockClear()
    await pruneWorkspaceSpaceAnalysisSnapshot(userDataDirHolder.dir, 'repo-1::/never-existed')
    await expect(readWorkspaceSpaceAnalysisSnapshot(userDataDirHolder.dir)).resolves.toEqual(cached)
    expect(snapshotWriteSpy).not.toHaveBeenCalled()
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
    await persistAnalysis(
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

  it('keeps profile snapshots isolated', async () => {
    const otherProfile = await mkdtemp(join(tmpdir(), 'orca-space-snapshot-other-'))
    try {
      await persistAnalysis(userDataDirHolder.dir, makeAnalysis([makeWorktreeRow()]))

      await expect(readWorkspaceSpaceAnalysisSnapshot(otherProfile)).resolves.toBeNull()
    } finally {
      await rm(otherProfile, { recursive: true, force: true })
    }
  })

  it('does not let an analysis started before bulk removal restore pruned rows', async () => {
    const local = makeWorktreeRow()
    const remote = makeWorktreeRow({
      worktreeId: 'repo-1::/remote-feature',
      executionHostId: 'ssh:ssh-1',
      isRemote: true,
      path: '/remote-feature'
    })
    const staleAnalysis = makeAnalysis([local, remote])
    // The analysis is in flight before the removal, so it is a fenced producer of this sidecar.
    const analysis = await openAnalysis(userDataDirHolder.dir)
    await pruneWorkspaceSpaceAnalysisSnapshots(userDataDirHolder.dir, [
      { worktreeId: local.worktreeId, executionHostId: 'local' },
      { worktreeId: remote.worktreeId, executionHostId: 'ssh:ssh-1' }
    ])

    await persistWorkspaceSpaceAnalysisSnapshot(
      userDataDirHolder.dir,
      staleAnalysis,
      analysis.producer
    )
    expect((await readWorkspaceSpaceAnalysisSnapshot(userDataDirHolder.dir))?.worktrees).toEqual([])

    await analysis.finish()
    // An analysis started after the removal is not fenced, so a re-created workspace comes back.
    await persistAnalysis(userDataDirHolder.dir, staleAnalysis)
    expect((await readWorkspaceSpaceAnalysisSnapshot(userDataDirHolder.dir))?.worktrees).toEqual([
      local,
      remote
    ])
  })

  it('registers a tombstone immediately without rewriting the sidecar', async () => {
    const staleAnalysis = makeAnalysis([makeWorktreeRow()])
    const analysis = await openAnalysis(userDataDirHolder.dir)

    registerWorkspaceSpaceAnalysisSnapshotPruneTombstones(userDataDirHolder.dir, [
      { worktreeId: 'repo-1::/repo-feature', executionHostId: 'local' }
    ])

    expect(snapshotWriteSpy).not.toHaveBeenCalled()
    await persistWorkspaceSpaceAnalysisSnapshot(
      userDataDirHolder.dir,
      staleAnalysis,
      analysis.producer
    )
    expect((await readWorkspaceSpaceAnalysisSnapshot(userDataDirHolder.dir))?.worktrees).toEqual([])
    await analysis.finish()
  })

  it('does not fence an analysis that started after a removal batch registered', async () => {
    const row = makeWorktreeRow()
    const target = { worktreeId: row.worktreeId, executionHostId: 'local' as const }
    registerWorkspaceSpaceAnalysisSnapshotPruneTombstones(userDataDirHolder.dir, [target])

    await finalizeWorkspaceSpaceAnalysisSnapshotPrunes(userDataDirHolder.dir, [target])
    await persistAnalysis(userDataDirHolder.dir, makeAnalysis([row]))

    expect((await readWorkspaceSpaceAnalysisSnapshot(userDataDirHolder.dir))?.worktrees).toEqual([
      { ...row, topLevelItems: [] }
    ])
  })

  it('retains no tombstone when a removal races no analysis at all', async () => {
    const row = makeWorktreeRow()
    await pruneWorkspaceSpaceAnalysisSnapshot(
      userDataDirHolder.dir,
      row.worktreeId,
      row.executionHostId
    )

    expect(workspaceSpaceAnalysisSnapshotTombstoneCountForTests(userDataDirHolder.dir)).toBe(0)
    await persistAnalysis(userDataDirHolder.dir, makeAnalysis([row]))
    expect((await readWorkspaceSpaceAnalysisSnapshot(userDataDirHolder.dir))?.worktrees).toEqual([
      row
    ])
  })

  it('does not accumulate tombstones as workspaces are removed', async () => {
    for (let index = 0; index < 25; index += 1) {
      await pruneWorkspaceSpaceAnalysisSnapshot(
        userDataDirHolder.dir,
        `repo-1::/repo-removed-${index}`,
        'local'
      )
    }

    expect(workspaceSpaceAnalysisSnapshotTombstoneCountForTests(userDataDirHolder.dir)).toBe(0)
  })

  it('holds a tombstone until the analysis in flight when it was pruned settles', async () => {
    const row = makeWorktreeRow()
    const analysis = await openAnalysis(userDataDirHolder.dir)
    await pruneWorkspaceSpaceAnalysisSnapshot(
      userDataDirHolder.dir,
      row.worktreeId,
      row.executionHostId
    )

    expect(workspaceSpaceAnalysisSnapshotTombstoneCountForTests(userDataDirHolder.dir)).toBe(1)
    await persistWorkspaceSpaceAnalysisSnapshot(
      userDataDirHolder.dir,
      makeAnalysis([row]),
      analysis.producer
    )
    expect((await readWorkspaceSpaceAnalysisSnapshot(userDataDirHolder.dir))?.worktrees).toEqual([])

    await analysis.finish()

    expect(workspaceSpaceAnalysisSnapshotTombstoneCountForTests(userDataDirHolder.dir)).toBe(0)
    await persistAnalysis(userDataDirHolder.dir, makeAnalysis([row]))
    expect((await readWorkspaceSpaceAnalysisSnapshot(userDataDirHolder.dir))?.worktrees).toEqual([
      row
    ])
  })

  it('keeps holding a tombstone when the wall clock jumps past the producer timeout', async () => {
    // A laptop sleep/resume moves Date.now() while the analysis's promise does not; expiring the
    // holder on that reading retires a tombstone whose producer is still about to write.
    const row = makeWorktreeRow()
    const analysis = await openAnalysis(userDataDirHolder.dir)
    await pruneWorkspaceSpaceAnalysisSnapshot(
      userDataDirHolder.dir,
      row.worktreeId,
      row.executionHostId
    )
    // Anchor on the real clock: NOW is a fixture constant in the past, so offsetting it would
    // step the clock backwards instead of forwards.
    const now = vi
      .spyOn(Date, 'now')
      .mockReturnValue(Date.now() + WORKSPACE_SNAPSHOT_PRUNE_PRODUCER_TIMEOUT_MS * 48)

    expect(workspaceSpaceAnalysisSnapshotTombstoneCountForTests(userDataDirHolder.dir)).toBe(1)
    await persistWorkspaceSpaceAnalysisSnapshot(
      userDataDirHolder.dir,
      makeAnalysis([row]),
      analysis.producer
    )

    expect((await readWorkspaceSpaceAnalysisSnapshot(userDataDirHolder.dir))?.worktrees).toEqual([])
    expect(workspaceSpaceAnalysisSnapshotTombstoneCountForTests(userDataDirHolder.dir)).toBe(1)
    now.mockRestore()
    await analysis.finish()
  })

  it('retires a tombstone whose analysis never settles once the producer timeout elapses', async () => {
    vi.useFakeTimers()
    try {
      const row = makeWorktreeRow()
      const analysis = await openAnalysis(userDataDirHolder.dir)
      await pruneWorkspaceSpaceAnalysisSnapshot(
        userDataDirHolder.dir,
        row.worktreeId,
        row.executionHostId
      )
      expect(workspaceSpaceAnalysisSnapshotTombstoneCountForTests(userDataDirHolder.dir)).toBe(1)

      await vi.advanceTimersByTimeAsync(WORKSPACE_SNAPSHOT_PRUNE_PRODUCER_TIMEOUT_MS + 1)
      expect(workspaceSpaceAnalysisSnapshotTombstoneCountForTests(userDataDirHolder.dir)).toBe(0)

      // Losing the bound disarms the producer, so the row it still holds cannot come back.
      snapshotWriteSpy.mockClear()
      await persistWorkspaceSpaceAnalysisSnapshot(
        userDataDirHolder.dir,
        makeAnalysis([row]),
        analysis.producer
      )
      expect(snapshotWriteSpy).not.toHaveBeenCalled()
      await analysis.finish()
    } finally {
      vi.useRealTimers()
    }
  })

  it('flushes a batched tombstone even when an analysis settles before the batch closes', async () => {
    const row = makeWorktreeRow()
    const target = { worktreeId: row.worktreeId, executionHostId: 'local' as const }
    await persistAnalysis(userDataDirHolder.dir, makeAnalysis([row]))
    const analysis = await openAnalysis(userDataDirHolder.dir)
    registerWorkspaceSpaceAnalysisSnapshotPruneTombstones(userDataDirHolder.dir, [target])
    await analysis.finish()

    expect(workspaceSpaceAnalysisSnapshotTombstoneCountForTests(userDataDirHolder.dir)).toBe(1)
    await finalizeWorkspaceSpaceAnalysisSnapshotPrunes(userDataDirHolder.dir, [target])

    expect((await readWorkspaceSpaceAnalysisSnapshot(userDataDirHolder.dir))?.worktrees).toEqual([])
    expect(workspaceSpaceAnalysisSnapshotTombstoneCountForTests(userDataDirHolder.dir)).toBe(0)
  })

  it('prunes host-colliding workspace ids without corrupting surviving totals', async () => {
    const local = makeWorktreeRow({ sizeBytes: 1000, reclaimableBytes: 1000 })
    const remote = makeWorktreeRow({
      executionHostId: 'ssh:ssh-1',
      isRemote: true,
      sizeBytes: 3000,
      reclaimableBytes: 3000
    })
    await persistAnalysis(userDataDirHolder.dir, makeAnalysis([local, remote]))

    await pruneWorkspaceSpaceAnalysisSnapshot(userDataDirHolder.dir, remote.worktreeId, 'ssh:ssh-1')

    const cached = await readWorkspaceSpaceAnalysisSnapshot(userDataDirHolder.dir)
    expect(cached?.worktrees).toEqual([local])
    expect(cached).toMatchObject({
      worktreeCount: 1,
      scannedWorktreeCount: 1,
      totalSizeBytes: 1000,
      reclaimableBytes: 1000
    })
    expect(cached?.repos).toEqual([
      expect.objectContaining({
        executionHostId: 'local',
        worktreeCount: 1,
        totalSizeBytes: 1000
      }),
      expect.objectContaining({
        executionHostId: 'ssh:ssh-1',
        worktreeCount: 0,
        totalSizeBytes: 0
      })
    ])
  })

  it('prunes every host-colliding row when the host is unknown', async () => {
    const local = makeWorktreeRow({ sizeBytes: 1000, reclaimableBytes: 1000 })
    const remote = makeWorktreeRow({
      executionHostId: 'ssh:ssh-1',
      isRemote: true,
      sizeBytes: 3000,
      reclaimableBytes: 3000
    })
    await persistAnalysis(userDataDirHolder.dir, makeAnalysis([local, remote]))

    await pruneWorkspaceSpaceAnalysisSnapshot(userDataDirHolder.dir, local.worktreeId)

    const cached = await readWorkspaceSpaceAnalysisSnapshot(userDataDirHolder.dir)
    expect(cached?.worktrees).toEqual([])
    expect(cached).toMatchObject({
      worktreeCount: 0,
      scannedWorktreeCount: 0,
      totalSizeBytes: 0,
      reclaimableBytes: 0
    })
  })
})
