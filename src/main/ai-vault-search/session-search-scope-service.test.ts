import { afterEach, describe, expect, it } from 'vitest'
import { AiVaultSearchRequestSchema } from '../../shared/ai-vault-search-contract'
import { fakeSearchService } from '../../shared/ai-vault-search-test-fixture'
import {
  installSessionSearchScopeCatalogSource,
  resetSessionSearchScopeCatalogForTests
} from './session-search-scope-catalog'
import { searchSessionService, setSessionSearchService } from './session-search-service-registry'

const CATALOG = {
  repos: [{ id: 'repo-1', path: '/work/app' }],
  projects: [],
  projectHostSetups: [],
  worktreeMeta: { 'repo-1::/work/app': {} },
  settings: { workspaceDir: '/home/me/orca/workspaces', nestWorkspaces: true }
}

afterEach(() => {
  setSessionSearchService(null)
  resetSessionSearchScopeCatalogForTests()
})

describe('scope identity at the search choke point', () => {
  it('narrows to the host’s own paths and acknowledges the scope it resolved', async () => {
    const service = fakeSearchService()
    setSessionSearchService(service)
    installSessionSearchScopeCatalogSource(() => CATALOG)
    await searchSessionService(
      { query: 'needle', within: { kind: 'workspace', worktreeId: 'repo-1::/work/app' } },
      'ipc'
    )
    // Beside the request, not inside `filters.scopePaths`, which carries a wire cap.
    expect(service.search).toHaveBeenCalledWith(
      { query: 'needle', limit: 20 },
      { kind: 'resolved', paths: ['/work/app'] }
    )
  })

  it('never forwards the identity to the engine, which only knows paths', async () => {
    const service = fakeSearchService()
    setSessionSearchService(service)
    installSessionSearchScopeCatalogSource(() => CATALOG)
    await searchSessionService(
      { query: 'needle', within: { kind: 'project', projectKey: 'repo:repo-1' } },
      'ipc'
    )
    // An exact match, so a leaked `within` would fail here as an extra key.
    expect(service.search).toHaveBeenCalledWith(
      { query: 'needle', limit: 20 },
      { kind: 'resolved', paths: ['/work/app', '/home/me/orca/workspaces/app'] }
    )
  })

  it('hands an unresolvable scope to the service rather than answering for it', async () => {
    const service = fakeSearchService()
    setSessionSearchService(service)
    installSessionSearchScopeCatalogSource(() => CATALOG)
    await searchSessionService(
      { query: 'needle', within: { kind: 'project', projectKey: 'repo:elsewhere' } },
      'ipc'
    )
    // The service owns the answer, because it owns the consent and readiness
    // checks that have to come first.
    expect(service.search).toHaveBeenCalledWith(
      { query: 'needle', limit: 20 },
      {
        kind: 'unknown'
      }
    )
    expect(service.status).not.toHaveBeenCalled()
  })

  it('says unknown on a host with no catalog at all, such as the relay', async () => {
    const service = fakeSearchService()
    setSessionSearchService(service)
    await searchSessionService(
      { query: 'needle', within: { kind: 'workspace', worktreeId: 'repo-1::/work/app' } },
      'ipc'
    )
    expect(service.search).toHaveBeenCalledWith(
      { query: 'needle', limit: 20 },
      {
        kind: 'unknown'
      }
    )
  })

  it('carries more paths than the request field could hold, and the request still re-parses', async () => {
    const worktreeMeta: Record<string, Record<string, never>> = {}
    for (let index = 0; index < 100; index++) {
      worktreeMeta[`repo-1::/home/me/ws/wt-${index}`] = {}
    }
    const service = fakeSearchService()
    setSessionSearchService(service)
    installSessionSearchScopeCatalogSource(() => ({
      ...CATALOG,
      worktreeMeta,
      settings: { workspaceDir: '/home/me/ws', nestWorkspaces: false }
    }))
    await searchSessionService(
      { query: 'needle', within: { kind: 'project', projectKey: 'repo:repo-1' } },
      'ipc'
    )
    const call = service.search.mock.lastCall
    expect(call?.[1]).toMatchObject({ kind: 'resolved', paths: expect.any(Array) })
    expect(Object(call?.[1]).paths).toHaveLength(101)
    // The scanner child re-parses the request it is handed; 101 paths inside
    // `filters.scopePaths` would be refused there and surface as "not ready".
    expect(() => AiVaultSearchRequestSchema.parse(call?.[0])).not.toThrow()
  })

  it('leaves an unscoped search unnarrowed', async () => {
    const service = fakeSearchService()
    setSessionSearchService(service)
    installSessionSearchScopeCatalogSource(() => CATALOG)
    await searchSessionService({ query: 'needle' }, 'ipc')
    expect(service.search).toHaveBeenCalledWith({ query: 'needle', limit: 20 }, undefined)
  })

  it('still honours an explicit path filter, which is what the CLI’s --path sends', async () => {
    const service = fakeSearchService()
    setSessionSearchService(service)
    installSessionSearchScopeCatalogSource(() => CATALOG)
    await searchSessionService({ query: 'needle', filters: { scopePaths: ['/other'] } }, 'ipc')
    expect(service.search).toHaveBeenCalledWith(
      { query: 'needle', limit: 20, filters: { scopePaths: ['/other'] } },
      undefined
    )
  })
})
