// The membership model under a background worktree removal: while the delete runs, the model's row
// keeps Git's path spelling, so the removal table's projection marks it; once the delete settles,
// the listing its publish triggers no longer has the row, even inside the reuse window.
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../shared/execution-host'
import { removeTree } from '../../../shared/windows-transient-lock-removal'
import {
  _resetPendingWorktreeRemovalsForTests,
  _settlePendingWorktreeRemovalsForTests,
  projectPendingWorktreeRemovals,
  snapshotPendingWorktreeRemovals,
  startBackgroundWorktreeRemoval
} from '../../worktree-background-removal'
import { listWorktreesStrict } from '../worktree-listing'
import { removeWorktree } from '../worktree-removal'
import {
  _resetWorktreeMembershipModelsForTests,
  readWorktreeMembership
} from './worktree-membership-store'

const execFileAsync = promisify(execFile)
const REPO_ID = 'repo-1'

/** A listing row as the removal projection reads it. */
type ListedRow = { id: string; hostId?: ExecutionHostId; removing?: true }

let scratchDir = ''
let repoPath = ''
let linked = ''

async function git(args: string[], cwd = repoPath): Promise<void> {
  await execFileAsync('git', args, { cwd })
}

async function listedIds(): Promise<string[]> {
  const { rows } = await readWorktreeMembership(repoPath)
  return rows.map((row) => `${REPO_ID}::${row.path}`)
}

beforeEach(async () => {
  scratchDir = await realpath(await mkdtemp(join(tmpdir(), 'orca-membership-removal-')))
  repoPath = join(scratchDir, 'repo')
  await mkdir(repoPath)
  await git(['init', '-q', '-b', 'main'])
  await writeFile(join(repoPath, 'seed.txt'), 'seed\n')
  await git(['add', '-A'])
  await git(['-c', 'user.email=r@example.invalid', '-c', 'user.name=R', 'commit', '-qm', 'seed'])
  linked = join(scratchDir, 'linked')
  await git(['worktree', 'add', '-q', linked, '-b', 'linked'])
  _resetWorktreeMembershipModelsForTests()
  _resetPendingWorktreeRemovalsForTests()
})

afterEach(async () => {
  vi.restoreAllMocks()
  _resetPendingWorktreeRemovalsForTests()
  _resetWorktreeMembershipModelsForTests()
  await removeTree(scratchDir)
})

describe('worktree membership model under a background removal', () => {
  it('lists a removing worktree under the id the removal table marks, then drops it once deleted', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.now())
    const gitRow = (await listWorktreesStrict(repoPath)).find((row) => row.path !== repoPath)!
    const worktreeId = `${REPO_ID}::${gitRow.path}`
    await listedIds()

    let releaseDelete = (): void => {}
    const deleteMayRun = new Promise<void>((resolve) => {
      releaseDelete = resolve
    })
    const publishedListings: string[][] = []
    const removal = startBackgroundWorktreeRemoval({
      removal: {
        worktreeId,
        repoId: REPO_ID,
        repoPath,
        deleteBranch: false,
        force: false,
        worktree: gitRow
      },
      run: async () => {
        await deleteMayRun
        return removeWorktree(repoPath, linked)
      },
      publish: () => {
        void listedIds().then((ids) => publishedListings.push(ids))
      }
    })

    // Mid-delete: the checkout is already gone, the admin entry is not. The model still lists the
    // row (as Git does, prunable) under Git's spelling, so the projection marks or hides it.
    await removeTree(linked)
    const snapshot = snapshotPendingWorktreeRemovals()
    const midDelete: ListedRow[] = (await listedIds()).map((id) => ({
      id,
      hostId: LOCAL_EXECUTION_HOST_ID
    }))
    expect(midDelete.map((row) => row.id)).toContain(worktreeId)
    expect(
      projectPendingWorktreeRemovals<ListedRow>(midDelete, (row) => row.id, true, snapshot).find(
        (row) => row.id === worktreeId
      )
    ).toEqual({ id: worktreeId, hostId: LOCAL_EXECUTION_HOST_ID, removing: true })
    expect(
      projectPendingWorktreeRemovals<ListedRow>(midDelete, (row) => row.id, false, snapshot).map(
        (row) => row.id
      )
    ).not.toContain(worktreeId)

    releaseDelete()
    await removal
    await _settlePendingWorktreeRemovalsForTests()
    // Same instant as the reads above: only the delete's generation bump stops a reused result.
    await expect(listedIds()).resolves.not.toContain(worktreeId)
    await vi.waitFor(() => expect(publishedListings.length).toBeGreaterThan(1))
    expect(publishedListings.at(-1)).not.toContain(worktreeId)
  })
})
