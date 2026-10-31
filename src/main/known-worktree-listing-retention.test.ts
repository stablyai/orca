import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../shared/constants'
import type { Repo } from '../shared/repo-types'
import type { WorktreeMeta } from '../shared/worktree/meta-types'
import type { GitWorktreeInfo } from '../shared/worktree/types'
import type { Store } from './persistence/loading-store/store'
import type { WorktreeRemovalRecord } from './worktree-removal-records'

const { presenceMock, branchMock, headMock } = vi.hoisted(() => ({
  presenceMock: vi.fn(),
  branchMock: vi.fn(),
  headMock: vi.fn()
}))

vi.mock('./local-worktree-path-presence', () => ({
  localWorktreePathsExistOrAreUnverifiable: async (paths: string[]) =>
    new Map(await Promise.all(paths.map(async (path) => [path, await presenceMock(path)] as const)))
}))
vi.mock('./git/worktree-list-reader', () => ({
  readCheckedOutBranchRef: branchMock,
  readWorktreeHeadOid: headMock
}))
vi.mock('./project-runtime-git-options', () => ({
  getLocalProjectWorktreeGitOptions: () => ({})
}))

import { retainKnownWorktreesInListing } from './known-worktree-listing-retention'
import { pendingWorktreeRemovals } from './worktree-removal-table'

const repo: Repo = {
  id: 'repo-1',
  path: 'C:\\work\\repo',
  displayName: 'repo',
  badgeColor: 'blue',
  addedAt: 1
}
const mainWsl = 'C:\\work\\repo'
const linkedWsl = 'C:\\work\\feature'

function row(path: string, isMainWorktree = false): GitWorktreeInfo {
  return { path, head: 'abc', branch: 'refs/heads/main', isBare: false, isMainWorktree }
}

function storeWith(options: {
  tabsFor?: string[]
  metaFor?: string[]
  onSessionRead?: () => void
}): { store: Store; forget: (id: string) => void } {
  const tabsFor = new Set(options.tabsFor ?? [])
  const metaFor = new Set(options.metaFor ?? [])
  const store = {
    getWorkspaceSession: () => {
      options.onSessionRead?.()
      return {
        ...getDefaultWorkspaceSession(),
        tabsByWorktree: Object.fromEntries([...tabsFor].map((id) => [id, []]))
      }
    },
    getAllWorktreeMeta: () =>
      Object.fromEntries([...metaFor].map((id) => [id, {} as WorktreeMeta])),
    getAllWorktreeMetaForHost: () =>
      Object.fromEntries([...metaFor].map((id) => [id, {} as WorktreeMeta]))
  } as unknown as Store
  return {
    store,
    forget: (id) => {
      tabsFor.delete(id)
      metaFor.delete(id)
    }
  }
}

describe('retainKnownWorktreesInListing', () => {
  beforeEach(() => {
    pendingWorktreeRemovals.clear()
    presenceMock.mockReset().mockResolvedValue(true)
    branchMock.mockReset().mockResolvedValue('refs/heads/feature')
    headMock.mockReset().mockResolvedValue('def')
  })

  it('keeps the saved spelling when Git lists the same folder another way', async () => {
    const { store } = storeWith({ tabsFor: [`repo-1::${mainWsl}`, `repo-1::${linkedWsl}`] })

    const listed = await retainKnownWorktreesInListing(store, repo, [
      row('C:/work/repo', true),
      row('C:/work/feature')
    ])

    expect(listed.map((worktree) => worktree.path)).toEqual([mainWsl, linkedWsl])
    expect(presenceMock).not.toHaveBeenCalled()
  })

  it('keeps a saved worktree that a cut-off or empty listing omits while its folder exists', async () => {
    const { store } = storeWith({
      tabsFor: [`repo-1::${mainWsl}`],
      metaFor: [`repo-1::${linkedWsl}`]
    })

    const listed = await retainKnownWorktreesInListing(store, repo, [])

    expect(listed).toEqual([
      {
        path: mainWsl,
        head: 'def',
        branch: 'refs/heads/feature',
        isBare: false,
        isMainWorktree: true
      },
      {
        path: linkedWsl,
        head: 'def',
        branch: 'refs/heads/feature',
        isBare: false,
        isMainWorktree: false
      }
    ])
  })

  it('lets the omission stand once the folder is gone under a reachable repo', async () => {
    const { store } = storeWith({ tabsFor: [`repo-1::${linkedWsl}`] })
    presenceMock.mockResolvedValue(false)

    const listed = await retainKnownWorktreesInListing(store, repo, [row(mainWsl, true)])

    expect(listed.map((worktree) => worktree.path)).toEqual([mainWsl])
  })

  it('keeps everything when Git did not read the repo, since an unmounted volume reads as absent', async () => {
    const { store } = storeWith({ tabsFor: [`repo-1::${linkedWsl}`] })
    presenceMock.mockResolvedValue(false)

    const listed = await retainKnownWorktreesInListing(store, repo, [])

    expect(listed.map((worktree) => worktree.path)).toEqual([linkedWsl])
  })

  it('never brings back a worktree Orca is removing or removed during the probe', async () => {
    let reads = 0
    const removedId = `repo-1::C:\\work\\removed`
    const { store, forget } = storeWith({
      tabsFor: [`repo-1::${linkedWsl}`, removedId],
      onSessionRead: () => {
        reads += 1
        if (reads === 2) {
          forget(removedId)
        }
      }
    })
    pendingWorktreeRemovals.set(`repo-1::${linkedWsl}`, {
      worktreeId: `repo-1::${linkedWsl}`,
      repoId: 'repo-1',
      worktreePath: 'C:/work/feature'
    } as WorktreeRemovalRecord)

    const listed = await retainKnownWorktreesInListing(store, repo, [row(mainWsl, true)])

    expect(listed.map((worktree) => worktree.path)).toEqual([mainWsl])
  })

  it('leaves listings of remote-host repos to their stored-row fallbacks', async () => {
    const { store } = storeWith({ tabsFor: [`repo-1::${linkedWsl}`] })

    const listed = await retainKnownWorktreesInListing(
      store,
      { ...repo, executionHostId: 'ssh:box' } as Repo,
      []
    )

    expect(listed).toEqual([])
  })
})
