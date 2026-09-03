import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  WorkspaceCleanupCandidate,
  WorkspaceCleanupScanArgs,
  WorkspaceCleanupScanResult
} from '../shared/workspace-cleanup'

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
  finalizeWorkspaceCleanupScanSnapshotPrunes,
  persistWorkspaceCleanupScanResult,
  pruneWorkspaceCleanupScanSnapshot,
  pruneWorkspaceCleanupScanSnapshots,
  readWorkspaceCleanupScanSnapshot,
  registerWorkspaceCleanupScanSnapshotPruneTombstones,
  withWorkspaceCleanupScanSnapshotProducer,
  workspaceCleanupScanSnapshotFingerprint,
  workspaceCleanupScanSnapshotTombstoneCountForTests
} from './workspace-cleanup-scan-snapshot'
import { WORKSPACE_SNAPSHOT_PRUNE_PRODUCER_TIMEOUT_MS } from './workspace-snapshot-prune-index'
import { openWorkspaceSnapshotPruneProducer } from './workspace-snapshot-prune-producer-fixtures'

const SNAPSHOT_FILE = 'orca-workspace-cleanup-scan.json'
const NOW = 1_700_000_000_000

function makeCandidate(
  overrides: Partial<WorkspaceCleanupCandidate> = {}
): WorkspaceCleanupCandidate {
  return {
    worktreeId: 'repo-1::/repo-feature',
    repoId: 'repo-1',
    repoName: 'Repo',
    connectionId: null,
    executionHostId: 'local',
    displayName: 'Feature',
    branch: 'feature',
    path: '/repo-feature',
    tier: 'ready',
    selectedByDefault: true,
    reasons: ['idle-clean'],
    blockers: [],
    lastActivityAt: NOW - 40 * 24 * 60 * 60 * 1000,
    localContext: {
      terminalTabCount: 0,
      cleanEditorTabCount: 0,
      browserTabCount: 0,
      diffCommentCount: 0,
      newestDiffCommentAt: null,
      retainedDoneAgentCount: 0
    },
    git: { clean: true, upstreamAhead: 0, upstreamBehind: 0, checkedAt: NOW },
    fingerprint: '2|feature|abc123|clean|19675',
    ...overrides
  }
}

function makeBroadResult(candidates: WorkspaceCleanupCandidate[]): WorkspaceCleanupScanResult {
  return { scannedAt: NOW, candidates, errors: [] }
}

/** A scan whose fence opens at persist time — one that raced no removal. */
function persistScan(
  snapshotDirectory: string,
  args: WorkspaceCleanupScanArgs,
  result: WorkspaceCleanupScanResult
): Promise<void> {
  return withWorkspaceCleanupScanSnapshotProducer(snapshotDirectory, (producer) =>
    persistWorkspaceCleanupScanResult(snapshotDirectory, args, result, producer)
  )
}

const openScan = (
  snapshotDirectory: string
): ReturnType<typeof openWorkspaceSnapshotPruneProducer> =>
  openWorkspaceSnapshotPruneProducer(withWorkspaceCleanupScanSnapshotProducer, snapshotDirectory)

describe('workspace cleanup scan snapshot', () => {
  beforeEach(async () => {
    snapshotWriteSpy.mockClear()
    userDataDirHolder.dir = await mkdtemp(join(tmpdir(), 'orca-cleanup-snapshot-'))
  })

  afterEach(async () => {
    await rm(userDataDirHolder.dir, { recursive: true, force: true })
  })

  it('round-trips a broad scan snapshot, including SSH connectionId rows', async () => {
    const sshCandidate = makeCandidate({
      worktreeId: 'repo-ssh::/remote/repo-feature',
      repoId: 'repo-ssh',
      connectionId: 'ssh-1',
      executionHostId: 'ssh:ssh-1',
      path: '/remote/repo-feature',
      blockers: ['ssh-disconnected'],
      git: { clean: null, upstreamAhead: null, upstreamBehind: null, checkedAt: null }
    })
    const result = makeBroadResult([makeCandidate(), sshCandidate])

    await persistScan(userDataDirHolder.dir, { includeAllWorkspaces: true }, result)

    await expect(readWorkspaceCleanupScanSnapshot(userDataDirHolder.dir)).resolves.toEqual(result)
  })

  it('does not let an older broad scan overwrite a newer snapshot', async () => {
    const newer = {
      scannedAt: NOW + 1,
      candidates: [makeCandidate({ displayName: 'Newer' })],
      errors: []
    }
    await persistScan(userDataDirHolder.dir, { includeAllWorkspaces: true }, newer)
    await persistScan(
      userDataDirHolder.dir,
      { includeAllWorkspaces: true },
      makeBroadResult([makeCandidate({ displayName: 'Older' })])
    )

    await expect(readWorkspaceCleanupScanSnapshot(userDataDirHolder.dir)).resolves.toEqual(newer)
  })

  it('returns null when no snapshot has been persisted', async () => {
    await expect(readWorkspaceCleanupScanSnapshot(userDataDirHolder.dir)).resolves.toBeNull()
  })

  it('degrades corrupt persisted blobs to null instead of throwing', async () => {
    const file = join(userDataDirHolder.dir, SNAPSHOT_FILE)

    await writeFile(file, 'not json{', 'utf-8')
    await expect(readWorkspaceCleanupScanSnapshot(userDataDirHolder.dir)).resolves.toBeNull()

    await writeFile(
      file,
      JSON.stringify({
        version: 2,
        argsFingerprint: workspaceCleanupScanSnapshotFingerprint(),
        result: { scannedAt: NOW, candidates: 'nope', errors: [] }
      }),
      'utf-8'
    )
    await expect(readWorkspaceCleanupScanSnapshot(userDataDirHolder.dir)).resolves.toBeNull()

    await writeFile(
      file,
      JSON.stringify({
        version: 2,
        argsFingerprint: workspaceCleanupScanSnapshotFingerprint(),
        result: { scannedAt: NOW, candidates: [{ worktreeId: 42 }], errors: [] }
      }),
      'utf-8'
    )
    await expect(readWorkspaceCleanupScanSnapshot(userDataDirHolder.dir)).resolves.toBeNull()
  })

  it('treats a snapshot from another classifier version as absent', async () => {
    await writeFile(
      join(userDataDirHolder.dir, SNAPSHOT_FILE),
      JSON.stringify({
        version: 2,
        argsFingerprint: 'classifier:1|includeAllWorkspaces',
        result: makeBroadResult([makeCandidate()])
      }),
      'utf-8'
    )

    await expect(readWorkspaceCleanupScanSnapshot(userDataDirHolder.dir)).resolves.toBeNull()
  })

  it('patches targeted rescans into the snapshot without touching other rows', async () => {
    const stale = makeCandidate({ git: { ...makeCandidate().git, clean: null, checkedAt: null } })
    const other = makeCandidate({
      worktreeId: 'repo-1::/repo-other',
      path: '/repo-other',
      branch: 'other'
    })
    await persistScan(
      userDataDirHolder.dir,
      { includeAllWorkspaces: true },
      makeBroadResult([stale, other])
    )

    const rescanned = makeCandidate({ tier: 'protected', blockers: ['dirty-files'] })
    await persistScan(
      userDataDirHolder.dir,
      { worktreeId: stale.worktreeId },
      { scannedAt: NOW + 60_000, candidates: [rescanned], errors: [] }
    )

    const snapshot = await readWorkspaceCleanupScanSnapshot(userDataDirHolder.dir)
    expect(snapshot?.candidates).toEqual([rescanned, other])
    // Snapshot freshness stays anchored to the last FULL scan.
    expect(snapshot?.scannedAt).toBe(NOW)
  })

  it('appends targeted rows the snapshot has not seen yet', async () => {
    await persistScan(
      userDataDirHolder.dir,
      { includeAllWorkspaces: true },
      makeBroadResult([makeCandidate()])
    )

    const created = makeCandidate({ worktreeId: 'repo-1::/repo-new', path: '/repo-new' })
    await persistScan(
      userDataDirHolder.dir,
      { worktreeId: created.worktreeId },
      { scannedAt: NOW + 1, candidates: [created], errors: [] }
    )

    const snapshot = await readWorkspaceCleanupScanSnapshot(userDataDirHolder.dir)
    expect(snapshot?.candidates.map((candidate) => candidate.worktreeId)).toEqual([
      'repo-1::/repo-feature',
      'repo-1::/repo-new'
    ])
  })

  it('does not create a snapshot from a targeted scan alone', async () => {
    await persistScan(
      userDataDirHolder.dir,
      { worktreeId: 'repo-1::/repo-feature' },
      makeBroadResult([makeCandidate()])
    )

    await expect(readWorkspaceCleanupScanSnapshot(userDataDirHolder.dir)).resolves.toBeNull()
    await expect(readFile(join(userDataDirHolder.dir, SNAPSHOT_FILE))).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })

  it('keeps the broad snapshot when a legacy suggestion-only scan completes', async () => {
    const broad = makeBroadResult([
      makeCandidate(),
      makeCandidate({ worktreeId: 'repo-1::/b', path: '/b' })
    ])
    await persistScan(userDataDirHolder.dir, { includeAllWorkspaces: true }, broad)

    const legacyRow = makeCandidate({ tier: 'review', selectedByDefault: false })
    await persistScan(
      userDataDirHolder.dir,
      {},
      { scannedAt: NOW + 1, candidates: [legacyRow], errors: [] }
    )

    const snapshot = await readWorkspaceCleanupScanSnapshot(userDataDirHolder.dir)
    expect(snapshot?.candidates).toHaveLength(2)
    expect(snapshot?.candidates[0]).toEqual(legacyRow)
  })

  it('prunes a removed worktree so it cannot resurrect from cache', async () => {
    const kept = makeCandidate({ worktreeId: 'repo-1::/repo-kept', path: '/repo-kept' })
    await persistScan(
      userDataDirHolder.dir,
      { includeAllWorkspaces: true },
      makeBroadResult([makeCandidate(), kept])
    )

    snapshotWriteSpy.mockClear()
    await pruneWorkspaceCleanupScanSnapshot(userDataDirHolder.dir, 'repo-1::/repo-feature', 'local')

    const snapshot = await readWorkspaceCleanupScanSnapshot(userDataDirHolder.dir)
    expect(snapshot?.candidates).toEqual([kept])
    expect(snapshotWriteSpy).toHaveBeenCalledTimes(1)

    // Unknown ids are a no-op.
    snapshotWriteSpy.mockClear()
    await pruneWorkspaceCleanupScanSnapshot(userDataDirHolder.dir, 'repo-1::/never-existed')
    await expect(readWorkspaceCleanupScanSnapshot(userDataDirHolder.dir)).resolves.toEqual(snapshot)
    expect(snapshotWriteSpy).not.toHaveBeenCalled()
  })

  it('coalesces host-scoped local and remote prunes into one write', async () => {
    const localCollision = makeCandidate()
    const remoteCollision = makeCandidate({
      connectionId: 'ssh-1',
      executionHostId: 'ssh:ssh-1'
    })
    const localRemoved = makeCandidate({
      worktreeId: 'repo-1::/local-removed',
      path: '/local-removed'
    })
    const remoteRemoved = makeCandidate({
      worktreeId: 'repo-1::/remote-removed',
      connectionId: 'ssh-1',
      executionHostId: 'ssh:ssh-1',
      path: '/remote-removed'
    })
    const kept = makeCandidate({ worktreeId: 'repo-1::/kept', path: '/kept' })
    await persistScan(
      userDataDirHolder.dir,
      { includeAllWorkspaces: true },
      makeBroadResult([localCollision, remoteCollision, localRemoved, remoteRemoved, kept])
    )

    snapshotWriteSpy.mockClear()
    await pruneWorkspaceCleanupScanSnapshots(userDataDirHolder.dir, [
      { worktreeId: localCollision.worktreeId, executionHostId: 'local' },
      { worktreeId: localRemoved.worktreeId, executionHostId: 'local' },
      { worktreeId: remoteRemoved.worktreeId, executionHostId: 'ssh:ssh-1' }
    ])

    expect(snapshotWriteSpy).toHaveBeenCalledTimes(1)
    expect(snapshotWriteSpy).toHaveBeenCalledWith(
      join(userDataDirHolder.dir, SNAPSHOT_FILE),
      expect.objectContaining({
        result: expect.objectContaining({ candidates: [remoteCollision, kept] })
      })
    )
    await expect(readWorkspaceCleanupScanSnapshot(userDataDirHolder.dir)).resolves.toMatchObject({
      candidates: [remoteCollision, kept]
    })

    snapshotWriteSpy.mockClear()
    await pruneWorkspaceCleanupScanSnapshots(userDataDirHolder.dir, [
      { worktreeId: 'repo-1::/missing-local', executionHostId: 'local' },
      { worktreeId: 'repo-1::/missing-remote', executionHostId: 'ssh:ssh-1' }
    ])
    expect(snapshotWriteSpy).not.toHaveBeenCalled()
  })

  it('keeps profile snapshots isolated', async () => {
    const otherProfile = await mkdtemp(join(tmpdir(), 'orca-cleanup-snapshot-other-'))
    try {
      await persistScan(
        userDataDirHolder.dir,
        { includeAllWorkspaces: true },
        makeBroadResult([makeCandidate()])
      )

      await expect(readWorkspaceCleanupScanSnapshot(otherProfile)).resolves.toBeNull()
    } finally {
      await rm(otherProfile, { recursive: true, force: true })
    }
  })

  it('does not let a scan started before a bulk removal restore pruned rows', async () => {
    const local = makeCandidate()
    const remote = makeCandidate({
      worktreeId: 'repo-1::/remote-feature',
      connectionId: 'ssh-1',
      executionHostId: 'ssh:ssh-1',
      path: '/remote-feature'
    })
    const staleResult = makeBroadResult([local, remote])
    // The scan is in flight before the removal, so it is a fenced producer of this sidecar.
    const scan = await openScan(userDataDirHolder.dir)
    await pruneWorkspaceCleanupScanSnapshots(userDataDirHolder.dir, [
      { worktreeId: local.worktreeId, executionHostId: 'local' },
      { worktreeId: remote.worktreeId, executionHostId: 'ssh:ssh-1' }
    ])

    await persistWorkspaceCleanupScanResult(
      userDataDirHolder.dir,
      { includeAllWorkspaces: true },
      staleResult,
      scan.producer
    )
    expect((await readWorkspaceCleanupScanSnapshot(userDataDirHolder.dir))?.candidates).toEqual([])

    await scan.finish()
    // A scan started after the removal is not fenced, so a re-created workspace comes back.
    await persistScan(userDataDirHolder.dir, { includeAllWorkspaces: true }, staleResult)
    expect((await readWorkspaceCleanupScanSnapshot(userDataDirHolder.dir))?.candidates).toEqual([
      local,
      remote
    ])
  })

  it('registers a tombstone immediately without rewriting the sidecar', async () => {
    const staleResult = makeBroadResult([makeCandidate()])
    const scan = await openScan(userDataDirHolder.dir)

    registerWorkspaceCleanupScanSnapshotPruneTombstones(userDataDirHolder.dir, [
      { worktreeId: 'repo-1::/repo-feature', executionHostId: 'local' }
    ])

    expect(snapshotWriteSpy).not.toHaveBeenCalled()
    await persistWorkspaceCleanupScanResult(
      userDataDirHolder.dir,
      { includeAllWorkspaces: true },
      staleResult,
      scan.producer
    )
    expect((await readWorkspaceCleanupScanSnapshot(userDataDirHolder.dir))?.candidates).toEqual([])
    await scan.finish()
  })

  it('does not fence a scan that started after a removal batch registered', async () => {
    const candidate = makeCandidate()
    const target = { worktreeId: candidate.worktreeId, executionHostId: 'local' as const }
    registerWorkspaceCleanupScanSnapshotPruneTombstones(userDataDirHolder.dir, [target])

    await finalizeWorkspaceCleanupScanSnapshotPrunes(userDataDirHolder.dir, [target])
    await persistScan(
      userDataDirHolder.dir,
      { includeAllWorkspaces: true },
      makeBroadResult([candidate])
    )

    expect((await readWorkspaceCleanupScanSnapshot(userDataDirHolder.dir))?.candidates).toEqual([
      candidate
    ])
  })

  it('retains no tombstone when a removal races no scan at all', async () => {
    const candidate = makeCandidate()
    await pruneWorkspaceCleanupScanSnapshot(
      userDataDirHolder.dir,
      candidate.worktreeId,
      candidate.executionHostId
    )

    expect(workspaceCleanupScanSnapshotTombstoneCountForTests(userDataDirHolder.dir)).toBe(0)
    // Nothing was fenced, so a later scan is free to persist the row again.
    await persistScan(
      userDataDirHolder.dir,
      { includeAllWorkspaces: true },
      makeBroadResult([candidate])
    )
    expect((await readWorkspaceCleanupScanSnapshot(userDataDirHolder.dir))?.candidates).toEqual([
      candidate
    ])
  })

  it('does not accumulate tombstones as workspaces are removed', async () => {
    for (let index = 0; index < 25; index += 1) {
      await pruneWorkspaceCleanupScanSnapshot(
        userDataDirHolder.dir,
        `repo-1::/repo-removed-${index}`,
        'local'
      )
    }

    expect(workspaceCleanupScanSnapshotTombstoneCountForTests(userDataDirHolder.dir)).toBe(0)
  })

  it('holds a tombstone until the scan in flight when it was pruned settles', async () => {
    const candidate = makeCandidate()
    const scan = await openScan(userDataDirHolder.dir)
    await pruneWorkspaceCleanupScanSnapshot(
      userDataDirHolder.dir,
      candidate.worktreeId,
      candidate.executionHostId
    )

    expect(workspaceCleanupScanSnapshotTombstoneCountForTests(userDataDirHolder.dir)).toBe(1)
    await persistWorkspaceCleanupScanResult(
      userDataDirHolder.dir,
      { includeAllWorkspaces: true },
      makeBroadResult([candidate]),
      scan.producer
    )
    expect((await readWorkspaceCleanupScanSnapshot(userDataDirHolder.dir))?.candidates).toEqual([])

    await scan.finish()

    expect(workspaceCleanupScanSnapshotTombstoneCountForTests(userDataDirHolder.dir)).toBe(0)
    await persistScan(
      userDataDirHolder.dir,
      { includeAllWorkspaces: true },
      makeBroadResult([candidate])
    )
    expect((await readWorkspaceCleanupScanSnapshot(userDataDirHolder.dir))?.candidates).toEqual([
      candidate
    ])
  })

  it('keeps holding a tombstone when the wall clock jumps past the producer timeout', async () => {
    // A laptop sleep/resume moves Date.now() while the scan's promise does not; expiring the
    // holder on that reading retires a tombstone whose producer is still about to write.
    const candidate = makeCandidate()
    const scan = await openScan(userDataDirHolder.dir)
    await pruneWorkspaceCleanupScanSnapshot(
      userDataDirHolder.dir,
      candidate.worktreeId,
      candidate.executionHostId
    )
    // Anchor on the real clock: NOW is a fixture constant in the past, so offsetting it would
    // step the clock backwards instead of forwards.
    const now = vi
      .spyOn(Date, 'now')
      .mockReturnValue(Date.now() + WORKSPACE_SNAPSHOT_PRUNE_PRODUCER_TIMEOUT_MS * 48)

    expect(workspaceCleanupScanSnapshotTombstoneCountForTests(userDataDirHolder.dir)).toBe(1)
    await persistWorkspaceCleanupScanResult(
      userDataDirHolder.dir,
      { includeAllWorkspaces: true },
      makeBroadResult([candidate]),
      scan.producer
    )

    expect((await readWorkspaceCleanupScanSnapshot(userDataDirHolder.dir))?.candidates).toEqual([])
    expect(workspaceCleanupScanSnapshotTombstoneCountForTests(userDataDirHolder.dir)).toBe(1)
    now.mockRestore()
    await scan.finish()
  })

  it('retires a tombstone whose scan never settles once the producer timeout elapses', async () => {
    vi.useFakeTimers()
    try {
      const candidate = makeCandidate()
      const scan = await openScan(userDataDirHolder.dir)
      await pruneWorkspaceCleanupScanSnapshot(
        userDataDirHolder.dir,
        candidate.worktreeId,
        candidate.executionHostId
      )
      expect(workspaceCleanupScanSnapshotTombstoneCountForTests(userDataDirHolder.dir)).toBe(1)

      await vi.advanceTimersByTimeAsync(WORKSPACE_SNAPSHOT_PRUNE_PRODUCER_TIMEOUT_MS + 1)
      expect(workspaceCleanupScanSnapshotTombstoneCountForTests(userDataDirHolder.dir)).toBe(0)

      // Losing the bound disarms the producer, so the row it still holds cannot come back.
      snapshotWriteSpy.mockClear()
      await persistWorkspaceCleanupScanResult(
        userDataDirHolder.dir,
        { includeAllWorkspaces: true },
        makeBroadResult([candidate]),
        scan.producer
      )
      expect(snapshotWriteSpy).not.toHaveBeenCalled()
      await scan.finish()
    } finally {
      vi.useRealTimers()
    }
  })

  it('flushes a batched tombstone even when a scan settles before the batch closes', async () => {
    const candidate = makeCandidate()
    const target = { worktreeId: candidate.worktreeId, executionHostId: 'local' as const }
    await persistScan(
      userDataDirHolder.dir,
      { includeAllWorkspaces: true },
      makeBroadResult([candidate])
    )
    const scan = await openScan(userDataDirHolder.dir)
    registerWorkspaceCleanupScanSnapshotPruneTombstones(userDataDirHolder.dir, [target])
    await scan.finish()

    // The deferred flush still holds it, so finalize can still find and prune the row.
    expect(workspaceCleanupScanSnapshotTombstoneCountForTests(userDataDirHolder.dir)).toBe(1)
    await finalizeWorkspaceCleanupScanSnapshotPrunes(userDataDirHolder.dir, [target])

    expect((await readWorkspaceCleanupScanSnapshot(userDataDirHolder.dir))?.candidates).toEqual([])
    expect(workspaceCleanupScanSnapshotTombstoneCountForTests(userDataDirHolder.dir)).toBe(0)
  })

  it('does not let one removal batch flush retire another batch tombstone', async () => {
    const first = makeCandidate()
    const second = makeCandidate({ worktreeId: 'repo-1::/repo-second', path: '/repo-second' })
    const firstTarget = { worktreeId: first.worktreeId, executionHostId: 'local' as const }
    const secondTarget = { worktreeId: second.worktreeId, executionHostId: 'local' as const }
    await persistScan(
      userDataDirHolder.dir,
      { includeAllWorkspaces: true },
      makeBroadResult([first, second])
    )
    registerWorkspaceCleanupScanSnapshotPruneTombstones(userDataDirHolder.dir, [firstTarget])
    registerWorkspaceCleanupScanSnapshotPruneTombstones(userDataDirHolder.dir, [secondTarget])

    await finalizeWorkspaceCleanupScanSnapshotPrunes(userDataDirHolder.dir, [firstTarget])
    expect(workspaceCleanupScanSnapshotTombstoneCountForTests(userDataDirHolder.dir)).toBe(1)

    await finalizeWorkspaceCleanupScanSnapshotPrunes(userDataDirHolder.dir, [secondTarget])
    expect((await readWorkspaceCleanupScanSnapshot(userDataDirHolder.dir))?.candidates).toEqual([])
    expect(workspaceCleanupScanSnapshotTombstoneCountForTests(userDataDirHolder.dir)).toBe(0)
  })

  it('patches and prunes host-colliding workspace ids independently', async () => {
    const local = makeCandidate()
    const remote = makeCandidate({
      connectionId: 'ssh-1',
      executionHostId: 'ssh:ssh-1',
      repoName: 'Remote repo'
    })
    await persistScan(
      userDataDirHolder.dir,
      { includeAllWorkspaces: true },
      makeBroadResult([local, remote])
    )

    const rescannedRemote = makeCandidate({
      ...remote,
      tier: 'protected',
      blockers: ['dirty-files']
    })
    await persistScan(
      userDataDirHolder.dir,
      { worktreeId: remote.worktreeId },
      { scannedAt: NOW + 1, candidates: [rescannedRemote], errors: [] }
    )
    expect((await readWorkspaceCleanupScanSnapshot(userDataDirHolder.dir))?.candidates).toEqual([
      local,
      rescannedRemote
    ])

    await pruneWorkspaceCleanupScanSnapshot(userDataDirHolder.dir, remote.worktreeId, 'ssh:ssh-1')
    expect((await readWorkspaceCleanupScanSnapshot(userDataDirHolder.dir))?.candidates).toEqual([
      local
    ])
  })
})
