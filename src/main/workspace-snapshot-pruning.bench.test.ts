// Opt in: ORCA_WORKSPACE_SNAPSHOT_PRUNE_BENCH=1 pnpm exec vitest run --config config/vitest.config.ts src/main/workspace-snapshot-pruning.bench.test.ts
import { performance } from 'node:perf_hooks'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { WorkspaceCleanupCandidate } from '../shared/workspace-cleanup'
import type { WorkspaceSpaceWorktree } from '../shared/workspace-space-types'
import {
  persistWorkspaceCleanupScanResult,
  pruneWorkspaceCleanupScanSnapshots
} from './workspace-cleanup-scan-snapshot'
import {
  persistWorkspaceSpaceAnalysisSnapshot,
  pruneWorkspaceSpaceAnalysisSnapshots
} from './workspace-space-analysis-snapshot'

const describeBench = process.env.ORCA_WORKSPACE_SNAPSHOT_PRUNE_BENCH ? describe : describe.skip
const ROW_COUNT = 610
const DELETE_COUNT = 100

describeBench('workspace snapshot bulk pruning', () => {
  let snapshotDirectory = ''

  beforeAll(async () => {
    snapshotDirectory = await mkdtemp(join(tmpdir(), 'orca-snapshot-prune-bench-'))
  })

  afterAll(async () => {
    await rm(snapshotDirectory, { recursive: true, force: true })
  })

  it('prunes the measured 610-row/100-delete shape with one write per sidecar', async () => {
    const candidates = Array.from({ length: ROW_COUNT }, (_, index) => makeCandidate(index))
    const worktrees = Array.from({ length: ROW_COUNT }, (_, index) => makeWorktree(index))
    const targets = candidates.slice(0, DELETE_COUNT).map((candidate) => ({
      worktreeId: candidate.worktreeId,
      executionHostId: candidate.executionHostId
    }))
    await persistWorkspaceCleanupScanResult(
      snapshotDirectory,
      { includeAllWorkspaces: true },
      { scannedAt: 1, candidates, errors: [] }
    )
    await persistWorkspaceSpaceAnalysisSnapshot(snapshotDirectory, {
      scannedAt: 1,
      totalSizeBytes: ROW_COUNT * 1_000,
      reclaimableBytes: ROW_COUNT * 1_000,
      worktreeCount: ROW_COUNT,
      scannedWorktreeCount: ROW_COUNT,
      unavailableWorktreeCount: 0,
      repos: makeRepoSummaries(worktrees),
      worktrees
    })

    const startedAt = performance.now()
    await Promise.all([
      pruneWorkspaceCleanupScanSnapshots(snapshotDirectory, targets),
      pruneWorkspaceSpaceAnalysisSnapshots(snapshotDirectory, targets)
    ])
    const pruneMs = performance.now() - startedAt
    const cleanupPayload = JSON.parse(
      await readFile(join(snapshotDirectory, 'orca-workspace-cleanup-scan.json'), 'utf-8')
    ) as { result: { candidates: unknown[] } }
    const spacePayload = JSON.parse(
      await readFile(join(snapshotDirectory, 'orca-workspace-space-analysis.json'), 'utf-8')
    ) as { analysis: { worktrees: unknown[] } }

    console.log(
      `[bench] rows=${ROW_COUNT} deleted=${DELETE_COUNT} bulkPrune=${pruneMs.toFixed(2)}ms`
    )
    expect(cleanupPayload.result.candidates).toHaveLength(ROW_COUNT - DELETE_COUNT)
    expect(spacePayload.analysis.worktrees).toHaveLength(ROW_COUNT - DELETE_COUNT)
  })
})

function executionHostId(index: number): 'local' | `ssh:${string}` {
  return index % 3 === 0 ? `ssh:ssh-${index % 7}` : 'local'
}

function makeCandidate(index: number): WorkspaceCleanupCandidate {
  const hostId = executionHostId(index)
  return {
    worktreeId: `repo-${index % 20}::/workspace-${index}`,
    repoId: `repo-${index % 20}`,
    repoName: `Repo ${index % 20}`,
    connectionId: hostId === 'local' ? null : hostId.slice('ssh:'.length),
    executionHostId: hostId,
    displayName: `Workspace ${index}`,
    branch: `branch-${index}`,
    path: `/workspace-${index}`,
    tier: 'ready',
    selectedByDefault: true,
    reasons: ['idle-clean'],
    blockers: [],
    lastActivityAt: 0,
    localContext: {
      terminalTabCount: 0,
      cleanEditorTabCount: 0,
      browserTabCount: 0,
      diffCommentCount: 0,
      newestDiffCommentAt: null,
      retainedDoneAgentCount: 0
    },
    git: { clean: true, upstreamAhead: 0, upstreamBehind: 0, checkedAt: 0 },
    fingerprint: `fingerprint-${index}`
  }
}

function makeWorktree(index: number): WorkspaceSpaceWorktree {
  const candidate = makeCandidate(index)
  return {
    worktreeId: candidate.worktreeId,
    repoId: candidate.repoId,
    executionHostId: candidate.executionHostId,
    repoDisplayName: candidate.repoName,
    repoPath: `/repo-${index % 20}`,
    displayName: candidate.displayName,
    path: candidate.path,
    branch: candidate.branch,
    isMainWorktree: false,
    isRemote: candidate.executionHostId !== 'local',
    isSparse: false,
    canDelete: true,
    lastActivityAt: 0,
    status: 'ok',
    error: null,
    scannedAt: 1,
    sizeBytes: 1_000,
    reclaimableBytes: 1_000,
    skippedEntryCount: 0,
    topLevelItems: [],
    omittedTopLevelItemCount: 0,
    omittedTopLevelSizeBytes: 0
  }
}

function makeRepoSummaries(worktrees: WorkspaceSpaceWorktree[]) {
  const groups = Map.groupBy(worktrees, (row) => `${row.executionHostId ?? 'local'}\0${row.repoId}`)
  return [...groups.values()].map((rows) => ({
    repoId: rows[0].repoId,
    executionHostId: rows[0].executionHostId,
    displayName: rows[0].repoDisplayName,
    path: rows[0].repoPath,
    isRemote: rows[0].isRemote,
    worktreeCount: rows.length,
    scannedWorktreeCount: rows.length,
    unavailableWorktreeCount: 0,
    totalSizeBytes: rows.length * 1_000,
    reclaimableBytes: rows.length * 1_000,
    error: null
  }))
}
