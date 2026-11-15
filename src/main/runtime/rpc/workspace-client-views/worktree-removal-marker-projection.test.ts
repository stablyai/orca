import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RemoveWorktreeResult } from '../../../../shared/worktree/create-types'
import { NATIVE_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../../../shared/protocol-version'
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../../../shared/electron-remote-runtime-client-capabilities'
import { remoteRuntimeClientCapabilities } from '../../../../shared/remote-runtime/remote-runtime-client-capabilities'
import type {
  RuntimeWorktreeListResult,
  RuntimeWorktreePsResult
} from '../../../../shared/runtime-worktree-contracts'
import {
  _resetPendingWorktreeRemovalsForTests,
  _settlePendingWorktreeRemovalsForTests,
  startBackgroundWorktreeRemoval,
  loadWorktreeRemovalRecords,
  waitForWorktreeRemovalAcceptance
} from '../../../workspaces/removal/worktree-background-removal'
import { snapshotPendingWorktreeRemovals } from '../../../workspaces/removal/worktree-removal-listing'
import {
  projectWorktreeListRemovals,
  projectWorktreePsRemovals
} from './worktree-removal-marker-projection'

const removingId = 'repo-1::/work/feature'
const keptId = 'repo-1::/work/other'

function listResult(): RuntimeWorktreeListResult {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the projection reads only id, hostId and the counts.
  return {
    worktrees: [
      { id: removingId, hostId: 'local' },
      { id: keptId, hostId: 'local' }
    ],
    totalCount: 2,
    truncated: false
  } as unknown as RuntimeWorktreeListResult
}

function psResult(): RuntimeWorktreePsResult {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the projection reads only worktreeId, hostId and the counts.
  return {
    worktrees: [
      { worktreeId: removingId, hostId: 'local' },
      { worktreeId: keptId, hostId: 'local' }
    ],
    totalCount: 2,
    truncated: false
  } as unknown as RuntimeWorktreePsResult
}

describe('worktree listings while a checkout is being deleted', () => {
  let directory = ''
  let cleanup = Promise.withResolvers<RemoveWorktreeResult>()
  beforeEach(async () => {
    cleanup = Promise.withResolvers<RemoveWorktreeResult>()
    directory = await mkdtemp(join(tmpdir(), 'orca-marker-projection-'))
    await loadWorktreeRemovalRecords(directory)
    void startBackgroundWorktreeRemoval({
      removal: {
        worktreeId: removingId,
        repoId: 'repo-1',
        repoPath: '/work/repo',
        worktree: { path: '/work/feature', branch: 'refs/heads/feature', head: 'abc' },
        deleteBranch: true,
        force: false
      },
      run: () => cleanup.promise,
      publish: () => {}
    })
    await waitForWorktreeRemovalAcceptance(removingId)
  })

  afterEach(async () => {
    cleanup.resolve({})
    await _settlePendingWorktreeRemovalsForTests()
    _resetPendingWorktreeRemovalsForTests()
    await rm(directory, { recursive: true, force: true })
  })

  it('marks the row for a desktop or web client that negotiated the marker', () => {
    const context = { clientCapabilities: ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES }
    expect(
      projectWorktreeListRemovals(listResult(), context, snapshotPendingWorktreeRemovals())
        .worktrees
    ).toEqual([
      { id: removingId, hostId: 'local', removing: true, removalRecorded: true },
      { id: keptId, hostId: 'local' }
    ])
    expect(
      projectWorktreePsRemovals(psResult(), context, snapshotPendingWorktreeRemovals()).worktrees
    ).toEqual([
      { worktreeId: removingId, hostId: 'local', removing: true, removalRecorded: true },
      { worktreeId: keptId, hostId: 'local' }
    ])
  })

  it('leaves the row out for a client that would show it as a normal workspace', () => {
    // An older desktop or web build, the CLI, the phone, and an in-process caller alike.
    for (const clientCapabilities of [
      [],
      undefined,
      NATIVE_REMOTE_RUNTIME_CLIENT_CAPABILITIES,
      remoteRuntimeClientCapabilities()
    ]) {
      const list = projectWorktreeListRemovals(
        listResult(),
        { clientCapabilities },
        snapshotPendingWorktreeRemovals()
      )
      expect(list.worktrees.map((row) => row.id)).toEqual([keptId])
      expect(list.totalCount).toBe(1)
      const ps = projectWorktreePsRemovals(
        psResult(),
        { clientCapabilities },
        snapshotPendingWorktreeRemovals()
      )
      expect(ps.worktrees.map((row) => row.worktreeId)).toEqual([keptId])
      expect(ps.totalCount).toBe(1)
    }
  })
})
