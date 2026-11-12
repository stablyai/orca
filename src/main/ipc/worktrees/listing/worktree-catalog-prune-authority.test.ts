import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import {
  _resetWorktreeCatalogOwnerForTests,
  isCurrentWorktreeCatalogObservation,
  readWorktreeCatalog
} from '../../../workspaces/catalog/repo-worktree-catalog-owner'
import { setWorktreeCatalogRouteResolver } from '../../../workspaces/catalog/repo-worktree-catalog-route'
import { pruneMetadataMissingFromAuthoritativeLocalScan } from './authoritative-local-worktree-metadata-pruning'

const repo = { id: 'repo-1', path: '/repos/app', kind: 'git' } as Repo
const goneWorktreeId = 'repo-1::/repos/app-gone'

describe('metadata pruning under catalog owner authority', () => {
  afterEach(() => {
    setWorktreeCatalogRouteResolver(null)
    _resetWorktreeCatalogOwnerForTests()
  })

  it('deletes nothing when the owner retires the route while the path probe is held', async () => {
    let live = true
    setWorktreeCatalogRouteResolver(() =>
      live ? { repoPath: repo.path, runtimeKey: 'local:default' } : null
    )
    const { observation } = await readWorktreeCatalog(
      repo,
      'local:default',
      { kind: 'desktop', maxAgeMs: 5_000 },
      {
        scan: async () => ({
          kind: 'rows',
          worktrees: [
            { path: repo.path, head: 'abc', branch: 'main', isBare: false, isMainWorktree: true }
          ]
        })
      }
    )
    let releaseProbe: (() => void) | undefined
    const pruneMissing = vi.fn(() => [goneWorktreeId])
    const pruning = pruneMetadataMissingFromAuthoritativeLocalScan({
      store: {
        getRepos: () => [repo],
        pruneSessionlessMissingLocalWorktreeMetadataForRepo: pruneMissing,
        getProfileStorageDirectory: () => '/profile'
      } as never,
      repo,
      gitWorktrees: [
        { path: repo.path, head: 'abc', branch: 'main', isBare: false, isMainWorktree: true }
      ],
      scan: {
        repo: { id: repo.id, path: repo.path },
        metadata: [{ worktreeId: goneWorktreeId }]
      } as never,
      scanGeneration: observation!.generation,
      platform: 'darwin',
      pathsExistOrAreUnverifiable: async (paths: readonly string[]) => {
        await new Promise<void>((resolve) => {
          releaseProbe = resolve
        })
        return new Map(paths.map((path) => [path, false]))
      },
      isCallerCurrent: () => isCurrentWorktreeCatalogObservation(observation!)
    })
    await vi.waitFor(() => expect(releaseProbe).toBeDefined())

    live = false
    releaseProbe!()

    expect((await pruning).removedWorktreeIds).toEqual([])
    expect(pruneMissing).not.toHaveBeenCalled()
  })
})
