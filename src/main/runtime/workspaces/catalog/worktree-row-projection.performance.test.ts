import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { removeTempDirs } from '../../../../shared/testing/remove-temp-dirs.test-support'
import { hostWorktreeTarget } from '../../../../shared/worktree/host-qualified-identity'
import type { GitWorktreeInfo } from '../../../../shared/worktree/types'
import {
  closeTestStores,
  createStore,
  makeRepo,
  testState
} from '../../../persistence/persistence-test-harness'
import { OrcaRuntimeService } from '../../orca-runtime'
import * as worktreeMetadataMerge from '../../../ipc/worktrees/metadata/worktree-metadata-merge'
import type * as WorktreeListingModule from '../../../git/worktrees/catalog/worktree-listing'
import type * as WorktreeScanCacheModule from '../../../git/worktrees/catalog/worktree-scan-cache'

// Perf contract (#43924): one metadata write re-merged every worktree row in the fleet on the next catalog join.

const { git } = vi.hoisted(() => {
  const worktrees: GitWorktreeInfo[] = []
  // What `git worktree list` reports for the fleet being built, and how often it was listed.
  return { git: { worktrees, listings: 0 } }
})
vi.mock('../../../git/worktrees/catalog/worktree-listing', async (importOriginal) => ({
  ...(await importOriginal<typeof WorktreeListingModule>()),
  listWorktreesStrict: async () => {
    git.listings += 1
    return git.worktrees
  }
}))
vi.mock('../../../git/worktrees/catalog/worktree-scan-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof WorktreeScanCacheModule>()),
  listWorktrees: async () => {
    git.listings += 1
    return git.worktrees
  }
}))
vi.mock('../../../../shared/sidebar-list/feed/sidebar-inputs-switch', () => ({
  ORCA_SIDEBAR_INPUTS_IS_MAIN: true
}))

const dirs: string[] = []
afterEach(async () => {
  await closeTestStores()
  await removeTempDirs(dirs.splice(0))
})

const worktreeId = (index: number) => `repo-1::/fleet/wt-${index}`

/** A runtime over one local repo whose git lists `size` checkouts, each with stored metadata. */
async function catalogFleet(size: number) {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-catalog-growth-'))
  dirs.push(testState.dir)
  const store = createStore()
  store.addRepo(makeRepo({ id: 'repo-1', path: '/fleet' }))
  const target = (index: number) => hostWorktreeTarget({ id: worktreeId(index), hostId: 'local' })
  for (let index = 0; index < size; index += 1) {
    store.setWorktreeMeta(target(index), { comment: `row ${index}` })
  }
  git.worktrees = Array.from({ length: size }, (_, index) => ({
    path: `/fleet/wt-${index}`,
    head: 'abc123',
    branch: `refs/heads/wt-${index}`,
    isBare: false,
    isMainWorktree: false
  }))
  const rows = new OrcaRuntimeService(store).workspaceRows!
  await rows.ready()
  const comment = (index: number) =>
    rows.resolvedWorktrees()?.find((worktree) => worktree.id === worktreeId(index))?.comment
  let writes = 0
  return {
    read: () => comment(7),
    writeOneComment: () => {
      writes += 1
      store.setWorktreeMeta(target(7), { comment: `edited ${writes}` })
      expect(comment(7)).toBe(`edited ${writes}`)
    },
    // A catalog event rejoins the cached scans with metadata nobody changed.
    rejoin: () => {
      rows.revision.bump()
      expect(comment(7)).toBe(`edited ${writes}`)
    }
  }
}

const FLEET_WORKTREES = 100

it('a catalog join after one metadata write merges only that row', async () => {
  // Merging a worktree's metadata into its row is the per-row work a full rebuild repeats.
  const merges = vi.spyOn(worktreeMetadataMerge, 'mergeWorktree')
  const fleet = await catalogFleet(FLEET_WORKTREES)
  // Building the fleet is disk I/O on the real clock; the joins being counted run on a fake one.
  vi.useFakeTimers()
  try {
    fleet.read()
    const work = () => ({ merges: merges.mock.calls.length, gitListings: git.listings })

    const beforeWrite = work()
    fleet.writeOneComment()
    expect(work()).toEqual({ ...beforeWrite, merges: beforeWrite.merges + 1 })

    // A rejoin with metadata nobody changed reuses every projected row.
    const beforeRejoin = work()
    fleet.rejoin()
    expect(work()).toEqual(beforeRejoin)
  } finally {
    vi.useRealTimers()
  }
})
