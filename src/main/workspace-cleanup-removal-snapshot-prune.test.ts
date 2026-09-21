import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  finalizeCleanupSnapshotsMock,
  finalizeSpaceSnapshotsMock,
  pruneCleanupSnapshotsMock,
  pruneSpaceSnapshotsMock,
  registerCleanupTombstonesMock,
  registerSpaceTombstonesMock
} = vi.hoisted(() => ({
  finalizeCleanupSnapshotsMock: vi.fn().mockResolvedValue(undefined),
  finalizeSpaceSnapshotsMock: vi.fn().mockResolvedValue(undefined),
  pruneCleanupSnapshotsMock: vi.fn().mockResolvedValue(undefined),
  pruneSpaceSnapshotsMock: vi.fn().mockResolvedValue(undefined),
  registerCleanupTombstonesMock: vi.fn(),
  registerSpaceTombstonesMock: vi.fn()
}))

vi.mock('./workspace-cleanup-scan-snapshot', () => ({
  finalizeWorkspaceCleanupScanSnapshotPrunes: finalizeCleanupSnapshotsMock,
  pruneWorkspaceCleanupScanSnapshots: pruneCleanupSnapshotsMock,
  registerWorkspaceCleanupScanSnapshotPruneTombstones: registerCleanupTombstonesMock
}))

vi.mock('./workspace-space-analysis-snapshot', () => ({
  finalizeWorkspaceSpaceAnalysisSnapshotPrunes: finalizeSpaceSnapshotsMock,
  pruneWorkspaceSpaceAnalysisSnapshots: pruneSpaceSnapshotsMock,
  registerWorkspaceSpaceAnalysisSnapshotPruneTombstones: registerSpaceTombstonesMock
}))

import {
  beginWorkspaceCleanupRemovalSnapshotPruneBatch,
  finishWorkspaceCleanupRemovalSnapshotPruneBatch,
  recordWorkspaceCleanupRemovalSnapshotPrune,
  resetWorkspaceCleanupRemovalSnapshotPruneBatchesForTests
} from './workspace-cleanup-removal-snapshot-prune'

describe('workspace cleanup removal snapshot prune batch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetWorkspaceCleanupRemovalSnapshotPruneBatchesForTests()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('registers every sequential tombstone immediately and flushes once per sidecar', async () => {
    const snapshotDirectory = '/profile-a'
    const batch = { batchId: 'batch-1' }
    const targets = Array.from({ length: 100 }, (_, index) => ({
      worktreeId: `repo-${index % 10}::/workspace-${index}`,
      executionHostId: index % 2 === 0 ? ('local' as const) : (`ssh:ssh-${index % 3}` as const)
    }))
    beginWorkspaceCleanupRemovalSnapshotPruneBatch(snapshotDirectory, batch)

    for (const target of targets) {
      recordWorkspaceCleanupRemovalSnapshotPrune(snapshotDirectory, { ...batch, ...target })
    }
    recordWorkspaceCleanupRemovalSnapshotPrune(snapshotDirectory, { ...batch, ...targets[0] })

    expect(registerCleanupTombstonesMock).toHaveBeenCalledTimes(100)
    expect(registerSpaceTombstonesMock).toHaveBeenCalledTimes(100)
    expect(finalizeCleanupSnapshotsMock).not.toHaveBeenCalled()
    expect(finalizeSpaceSnapshotsMock).not.toHaveBeenCalled()

    await finishWorkspaceCleanupRemovalSnapshotPruneBatch(snapshotDirectory, batch)

    expect(finalizeCleanupSnapshotsMock).toHaveBeenCalledExactlyOnceWith(snapshotDirectory, targets)
    expect(finalizeSpaceSnapshotsMock).toHaveBeenCalledExactlyOnceWith(snapshotDirectory, targets)
  })

  it('falls back to immediate best-effort pruning when no batch is active', () => {
    const target = { worktreeId: 'repo-1::/workspace', executionHostId: 'runtime:vm-1' as const }

    recordWorkspaceCleanupRemovalSnapshotPrune('/profile-a', {
      batchId: 'missing-batch',
      ...target
    })

    expect(pruneCleanupSnapshotsMock).toHaveBeenCalledExactlyOnceWith('/profile-a', [target])
    expect(pruneSpaceSnapshotsMock).toHaveBeenCalledExactlyOnceWith('/profile-a', [target])
  })

  it('finalizes only the matching profile and batch scope', async () => {
    const batch = { batchId: 'shared-id' }
    const profileATarget = { worktreeId: 'repo-a::/workspace', executionHostId: 'local' as const }
    const profileBTarget = {
      worktreeId: 'repo-b::/workspace',
      executionHostId: 'ssh:ssh-1' as const
    }
    beginWorkspaceCleanupRemovalSnapshotPruneBatch('/profile-a', batch)
    beginWorkspaceCleanupRemovalSnapshotPruneBatch('/profile-b', batch)
    recordWorkspaceCleanupRemovalSnapshotPrune('/profile-a', { ...batch, ...profileATarget })
    recordWorkspaceCleanupRemovalSnapshotPrune('/profile-b', { ...batch, ...profileBTarget })

    await finishWorkspaceCleanupRemovalSnapshotPruneBatch('/profile-a', batch)

    expect(finalizeCleanupSnapshotsMock).toHaveBeenCalledExactlyOnceWith('/profile-a', [
      profileATarget
    ])
    expect(finalizeSpaceSnapshotsMock).toHaveBeenCalledExactlyOnceWith('/profile-a', [
      profileATarget
    ])

    await finishWorkspaceCleanupRemovalSnapshotPruneBatch('/profile-b', batch)
    expect(finalizeCleanupSnapshotsMock).toHaveBeenNthCalledWith(2, '/profile-b', [profileBTarget])
    expect(finalizeSpaceSnapshotsMock).toHaveBeenNthCalledWith(2, '/profile-b', [profileBTarget])
  })

  it('expires and finalizes an unfinished idle batch', async () => {
    vi.useFakeTimers()
    const batch = { batchId: 'abandoned-batch' }
    const target = { worktreeId: 'repo-1::/workspace', executionHostId: 'local' as const }
    beginWorkspaceCleanupRemovalSnapshotPruneBatch('/profile-a', batch)
    recordWorkspaceCleanupRemovalSnapshotPrune('/profile-a', { ...batch, ...target })

    await vi.advanceTimersByTimeAsync(5 * 60_000)

    expect(finalizeCleanupSnapshotsMock).toHaveBeenCalledExactlyOnceWith('/profile-a', [target])
    expect(finalizeSpaceSnapshotsMock).toHaveBeenCalledExactlyOnceWith('/profile-a', [target])
    await finishWorkspaceCleanupRemovalSnapshotPruneBatch('/profile-a', batch)
    expect(finalizeCleanupSnapshotsMock).toHaveBeenCalledTimes(1)
    expect(finalizeSpaceSnapshotsMock).toHaveBeenCalledTimes(1)
  })
})
