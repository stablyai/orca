import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeWorktreeRemovalState } from '../shared/runtime-worktree-contracts'
import {
  _resetPendingWorktreeRemovalsForTests,
  _settlePendingWorktreeRemovalsForTests,
  startBackgroundWorktreeRemoval
} from './worktree-background-removal'
import type { WorktreeRemovalRecord } from './worktree-removal-records'
import { failedWorktreeRemovals, pendingWorktreeRemovals } from './worktree-removal-table'
import { readWorktreeRemovalState } from './worktree-removal-state'

// Git's view of a failed delete's leftover: unregistered, and Orca's own leftover.
vi.mock('./worktree-removal-leftover', () => ({
  differentCheckoutAtPathError: (path: string) => new Error(`different checkout at ${path}`),
  isCheckoutRegistered: vi.fn(async () => false),
  isUnregisteredRemovalLeftover: vi.fn(async () => true)
}))

const ID = 'repo-1::/nonexistent/orca-rm-wait/wt-1'

function record(failure?: WorktreeRemovalRecord['failure']): WorktreeRemovalRecord {
  return {
    worktreeId: ID,
    repoId: 'repo-1',
    repoPath: '/tmp/repo',
    worktreePath: '/tmp/wt-1',
    branch: 'feature',
    head: 'abc',
    deleteBranch: true,
    force: false,
    requestedAt: 1,
    ...(failure ? { failure } : {})
  }
}

function reads(listed: boolean, preservedBranch?: { branchName: string; head: string }) {
  return {
    isListed: vi.fn(async () => listed),
    preservedBranch: vi.fn(() => preservedBranch)
  }
}

describe('readWorktreeRemovalState', () => {
  afterEach(() => {
    _resetPendingWorktreeRemovalsForTests()
    pendingWorktreeRemovals.clear()
    failedWorktreeRemovals.clear()
  })

  it('is removing while the host still runs the delete, even though Git lists the row', async () => {
    pendingWorktreeRemovals.set(ID, record())
    const read = reads(true)

    expect(await readWorktreeRemovalState(ID, 'local', read)).toEqual({ state: 'removing' })
    expect(read.isListed).not.toHaveBeenCalled()
  })

  it("reports a failed delete with Git's own error", async () => {
    failedWorktreeRemovals.set(
      ID,
      record({ message: 'Failed to delete worktree at /tmp/wt-1: Permission denied', failedAt: 2 })
    )

    expect(await readWorktreeRemovalState(ID, undefined, reads(true))).toEqual({
      state: 'failed',
      message: 'Failed to delete worktree at /tmp/wt-1: Permission denied'
    })
  })

  it('is present when no delete runs and the workspace is still listed', async () => {
    expect(await readWorktreeRemovalState(ID, 'local', reads(true))).toEqual({ state: 'present' })
  })

  it('is removed once the workspace is gone, carrying the branch the delete kept', async () => {
    expect(
      await readWorktreeRemovalState(
        ID,
        'local',
        reads(false, { branchName: 'feature', head: 'abc' })
      )
    ).toEqual({ state: 'removed', preservedBranch: { branchName: 'feature', head: 'abc' } })
    expect(await readWorktreeRemovalState(ID, 'local', reads(false))).toEqual({ state: 'removed' })
  })

  it("does not read this host's records for a workspace another host deletes", async () => {
    pendingWorktreeRemovals.set(ID, record())

    expect(await readWorktreeRemovalState(ID, 'ssh:box', reads(false))).toEqual({
      state: 'removed'
    })
  })

  it('is present while the checkout folder is still on disk, even when Git no longer lists it', async () => {
    const checkout = mkdtempSync(join(tmpdir(), 'orca-rm-state-'))

    expect(await readWorktreeRemovalState(`repo-1::${checkout}`, 'local', reads(false))).toEqual({
      state: 'present'
    })
  })
})

// Why the real removal table: the read is only right if a settled delete leaves `pending` and
// writes its failure in one step, with nothing a poll could see in between.
describe('readWorktreeRemovalState over a real background removal', () => {
  afterEach(() => {
    _resetPendingWorktreeRemovalsForTests()
    failedWorktreeRemovals.clear()
  })

  async function pollThrough(
    worktreeId: string,
    gitListsIt: () => boolean,
    settle: () => void
  ): Promise<RuntimeWorktreeRemovalState['state'][]> {
    const read = { isListed: async () => gitListsIt(), preservedBranch: () => undefined }
    const seen = [(await readWorktreeRemovalState(worktreeId, 'local', read)).state]
    settle()
    let settled = false
    const done = _settlePendingWorktreeRemovalsForTests().then(() => {
      settled = true
    })
    // Read on every turn of the event loop until the delete has fully settled.
    while (!settled) {
      seen.push((await readWorktreeRemovalState(worktreeId, 'local', read)).state)
      await new Promise((resolve) => setImmediate(resolve))
    }
    await done
    seen.push((await readWorktreeRemovalState(worktreeId, 'local', read)).state)
    return [...new Set(seen)]
  }

  function start(worktreePath: string, run: () => Promise<Record<string, never>>): string {
    const worktreeId = `repo-1::${worktreePath}`
    void startBackgroundWorktreeRemoval({
      removal: {
        worktreeId,
        repoId: 'repo-1',
        repoPath: '/nonexistent/orca-rm-wait/repo',
        worktree: { path: worktreePath, branch: 'refs/heads/feature', head: 'abc' },
        deleteBranch: true,
        force: false
      },
      run,
      publish: () => {}
    }).catch(() => {})
    return worktreeId
  }

  it('goes from removing straight to removed', async () => {
    const { promise, resolve } = Promise.withResolvers<Record<string, never>>()
    let gitDone = false
    const worktreeId = start('/nonexistent/orca-rm-wait/wt-ok', () => promise)

    const states = await pollThrough(
      worktreeId,
      () => !gitDone,
      () => {
        gitDone = true
        resolve({})
      }
    )
    expect(states).toEqual(['removing', 'removed'])
  })

  it("goes from removing straight to failed, with Git's error", async () => {
    const leftover = mkdtempSync(join(tmpdir(), 'orca-rm-state-'))
    const { promise, reject } = Promise.withResolvers<Record<string, never>>()
    const worktreeId = start(leftover, () => promise)

    const states = await pollThrough(
      worktreeId,
      () => false,
      () => reject(new Error('Permission denied'))
    )
    expect(states).toEqual(['removing', 'failed'])
    expect(await readWorktreeRemovalState(worktreeId, 'local', reads(false))).toEqual({
      state: 'failed',
      message: 'Permission denied'
    })
  })
})
