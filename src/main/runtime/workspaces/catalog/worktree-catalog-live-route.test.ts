import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  isLiveWorktreeCatalogRoute,
  setWorktreeCatalogRouteResolver
} from '../../../workspaces/catalog/repo-worktree-catalog-route'
import { registerWorktreeCatalogRoutes } from './worktree-catalog-live-route'

function storeWith(repoCount: number) {
  const repos = Array.from({ length: repoCount }, (_unused, index) => ({
    id: `repo-${index}`,
    path: `/repos/app-${index}`,
    kind: 'git' as const
  }))
  return { getRepos: vi.fn(() => repos), getProjects: () => [], getSettings: () => ({}) }
}

describe('worktree catalog live route', () => {
  afterEach(() => {
    setWorktreeCatalogRouteResolver(null)
  })

  it('reads the repo registry once per pass however many owners check liveness', () => {
    for (const repoCount of [20, 200]) {
      const store = storeWith(repoCount)
      registerWorktreeCatalogRoutes(store as never)
      for (let index = 0; index < repoCount; index += 1) {
        expect(
          isLiveWorktreeCatalogRoute(`repo-${index}`, 'local', {
            repoPath: `/repos/app-${index}`,
            runtimeKey: 'local:default'
          })
        ).toBe(true)
      }
      expect(store.getRepos).toHaveBeenCalledTimes(1)
    }
  })

  it('treats a replaced path or an unregistered repo as obsolete', () => {
    registerWorktreeCatalogRoutes(storeWith(1) as never)
    const route = { repoPath: '/repos/app-0', runtimeKey: 'local:default' }
    expect(
      isLiveWorktreeCatalogRoute('repo-0', 'local', { ...route, repoPath: '/repos/old' })
    ).toBe(false)
    expect(isLiveWorktreeCatalogRoute('repo-9', 'local', route)).toBe(false)
  })
})
