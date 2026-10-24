import * as fs from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import { projectHostSetupCompatibilityFromRepos } from '../../shared/project-host-setup-projection'
import {
  installSessionSearchScopeCatalogSource,
  resetSessionSearchScopeCatalogForTests,
  type SessionSearchScopeCatalog
} from './session-search-scope-catalog'
import { createSessionSearchService } from './session-search-service'
import { searchSessionService, setSessionSearchService } from './session-search-service-registry'
import {
  openSessionSearchHarness,
  addSyntheticSession,
  type SessionSearchHarness
} from './session-search-engine-test-fixture'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>()
  return { ...actual, realpath: vi.fn(actual.realpath) }
})
let harness: SessionSearchHarness | undefined
afterEach(async () => {
  setSessionSearchService(null)
  resetSessionSearchScopeCatalogForTests()
  vi.restoreAllMocks()
  await harness?.close()
  harness = undefined
})
function latch() {
  let release: () => void = () => undefined
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

it('captures after freshness and rejects governing ownership changes across alias and child awaits without new work', async () => {
  const repos: Repo[] = ['a', 'b'].map((id, index) => ({
    id,
    path: `/repos/${id}`,
    displayName: id,
    badgeColor: '',
    addedAt: index,
    upstream: { owner: 'acme', repo: 'app' }
  }))
  const raw = projectHostSetupCompatibilityFromRepos(repos)
  let catalog: SessionSearchScopeCatalog = {
    repos,
    projects: raw.projects,
    projectHostSetups: raw.setups,
    worktreeMeta: {},
    settings: { workspaceDir: '', nestWorkspaces: false }
  }
  installSessionSearchScopeCatalogSource(() => catalog)
  harness = await openSessionSearchHarness('sta10541-ownership-await')
  addSyntheticSession(harness.db, { id: 1, cwd: '/after-freshness' })
  const fresh = latch()
  const reconciling = latch()
  const native = createSessionSearchService({
    engine: harness.engine,
    indexer: {
      status: () => {
        throw new Error('not called')
      },
      reconcile: async () => {
        reconciling.release()
        await fresh.promise
      }
    }
  })
  const admission = vi.spyOn(native, 'search')
  setSessionSearchService(native)
  const request = {
    query: 'needle',
    within: {
      kind: 'project',
      projectKey: `project:${raw.projects[0].id}`,
      canonicalProjectKey: 'repo:b'
    }
  }
  const first = searchSessionService({ ...request, freshness: 'wait-until-current' }, 'ipc')
  await reconciling.promise
  catalog = {
    ...catalog,
    worktreeMeta: {
      'b::/after-freshness': { projectHostSetupId: 'b', projectId: raw.projects[0].id }
    }
  }
  fresh.release()
  expect(await first).toMatchObject({ kind: 'results', hits: [{ sessionId: '1' }] })
  expect(admission).toHaveBeenCalledTimes(1)

  const aliasEntered = latch()
  const aliasRelease = latch()
  const realpath = vi.mocked(fs.realpath)
  const delegate = realpath.getMockImplementation()!
  realpath.mockImplementationOnce(async (...args) => {
    aliasEntered.release()
    await aliasRelease.promise
    return delegate(...args)
  })
  const aliasRace = searchSessionService(request, 'ipc')
  await aliasEntered.promise
  repos[1].path = '/repos/b-moved'
  aliasRelease.release()
  expect(await aliasRace).toMatchObject({ kind: 'stale-cursor' })
  expect(admission).toHaveBeenCalledTimes(1)

  const childEntered = latch()
  const childRelease = latch()
  const child = {
    ...native,
    search: vi.fn(async (...args: Parameters<typeof native.search>) => {
      const result = await native.search(...args)
      childEntered.release()
      await childRelease.promise
      return result
    })
  }
  setSessionSearchService(child)
  const childRace = searchSessionService(request, 'ipc')
  await childEntered.promise
  catalog = {
    ...catalog,
    worktreeMeta: { ...catalog.worktreeMeta, 'a::/after-freshness': { projectHostSetupId: 'a' } }
  }
  childRelease.release()
  expect(await childRace).toMatchObject({ kind: 'stale-cursor' })
  expect(child.search).toHaveBeenCalledTimes(1)
})
