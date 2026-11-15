import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  isLiveWorktreeCatalogRoute,
  setWorktreeCatalogRouteResolver
} from '../../../workspaces/catalog/repo-worktree-catalog-route'
import { markWorktreeRouteInputsChanged } from '../../../workspaces/catalog/local-worktree-scan-generation'
import { registerWorktreeCatalogRoutes } from './worktree-catalog-live-route'

function storeWith(repoCount: number) {
  const repos: { id: string; path: string; kind: 'git' | 'folder' }[] = Array.from(
    { length: repoCount },
    (_unused, index) => ({ id: `repo-${index}`, path: `/repos/app-${index}`, kind: 'git' })
  )
  const projects = repos.map((repo, index) => ({
    id: `project-${index}`,
    sourceRepoIds: [repo.id]
  }))
  return {
    repos,
    getRepos: vi.fn(() => repos.map((repo) => ({ ...repo }))),
    getProjects: vi.fn(() => [...projects]),
    getSettings: () => ({})
  }
}

// Pinned to a non-Windows host, where each project resolves to its own host runtime.
const routeOf = (index: number) => ({
  repoPath: `/repos/app-${index}`,
  runtimeKey: `project-${index}:local-host:darwin`
})
const realPlatform = process.platform

describe('worktree catalog live route', () => {
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
  })
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform })
    setWorktreeCatalogRouteResolver(null)
  })

  it('reads the registry and projects once per route change however many owners check', async () => {
    for (const repoCount of [12, 120]) {
      const store = storeWith(repoCount)
      registerWorktreeCatalogRoutes(store as never)
      for (let pass = 0; pass < 3; pass += 1) {
        for (let index = 0; index < repoCount; index += 1) {
          expect(isLiveWorktreeCatalogRoute(`repo-${index}`, 'local', routeOf(index))).toBe(true)
        }
        await Promise.resolve()
      }
      expect(store.getRepos).toHaveBeenCalledTimes(1)
      expect(store.getProjects.mock.calls.length).toBeLessThanOrEqual(2)

      markWorktreeRouteInputsChanged()
      expect(isLiveWorktreeCatalogRoute('repo-0', 'local', routeOf(0))).toBe(true)
      expect(store.getRepos).toHaveBeenCalledTimes(2)
    }
  })

  it('rejects a captured route as soon as the registration changes, before any later read', () => {
    const store = storeWith(2)
    registerWorktreeCatalogRoutes(store as never)
    expect(isLiveWorktreeCatalogRoute('repo-0', 'local', routeOf(0))).toBe(true)

    store.repos[0].kind = 'folder'
    store.repos[1].path = '/repos/renamed'
    markWorktreeRouteInputsChanged()

    expect(isLiveWorktreeCatalogRoute('repo-0', 'local', routeOf(0))).toBe(false)
    expect(isLiveWorktreeCatalogRoute('repo-1', 'local', routeOf(1))).toBe(false)
    expect(isLiveWorktreeCatalogRoute('repo-9', 'local', routeOf(9))).toBe(false)
  })
})
