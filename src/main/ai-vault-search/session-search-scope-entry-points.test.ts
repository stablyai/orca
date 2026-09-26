import { afterEach, describe, expect, it } from 'vitest'
import { AiVaultHandler } from '../../relay/ai-vault-handler'
import type { RelayDispatcher } from '../../relay/dispatcher'
import { createSessionSearchClient } from '../../shared/ai-vault-search-client'
import { fakeSearchService } from '../../shared/ai-vault-search-test-fixture'
import { RpcDispatcher } from '../runtime/rpc/dispatcher'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { AI_VAULT_METHODS } from '../runtime/rpc/methods/ai-vault'
import {
  installSessionSearchScopeCatalogSource,
  resetSessionSearchScopeCatalogForTests
} from './session-search-scope-catalog'
import { searchSessionService, setSessionSearchService } from './session-search-service-registry'

const CATALOG = {
  repos: [{ id: 'repo-1', path: '/work/app' }],
  projects: [],
  projectHostSetups: [],
  worktreeMeta: {},
  settings: { workspaceDir: '/home/me/orca/workspaces', nestWorkspaces: true }
}
const WITHIN = { kind: 'workspace', worktreeId: 'repo-1::/work/app' } as const

afterEach(() => {
  setSessionSearchService(null)
  resetSessionSearchScopeCatalogForTests()
})

function relayHandler(): (params: Record<string, unknown>) => Promise<unknown> {
  const handlers = new Map<string, (params: Record<string, unknown>) => Promise<unknown>>()
  const dispatcher = {
    onRequest: (method: string, handler: (params: Record<string, unknown>) => Promise<unknown>) => {
      handlers.set(method, handler)
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler only calls `onRequest`, and the test asserts the registration it makes.
  new AiVaultHandler(dispatcher as unknown as RelayDispatcher)
  const search = handlers.get('aiVault.searchSessions')
  if (!search) {
    throw new Error('relay registered no session search handler')
  }
  return search
}

describe('every search entry point carries the scope identity through', () => {
  it('resolves over the in-process IPC entry point', async () => {
    const service = fakeSearchService()
    setSessionSearchService(service)
    installSessionSearchScopeCatalogSource(() => CATALOG)
    await searchSessionService({ query: 'needle', within: WITHIN }, 'ipc')
    expect(service.search).toHaveBeenCalledWith(expect.anything(), {
      kind: 'resolved',
      paths: ['/work/app']
    })
  })

  it('resolves over the runtime RPC method', async () => {
    const service = fakeSearchService()
    setSessionSearchService(service)
    installSessionSearchScopeCatalogSource(() => CATALOG)
    const rpc = new RpcDispatcher({
      runtime: new OrcaRuntimeService(),
      methods: AI_VAULT_METHODS
    })
    await rpc.dispatch({
      id: 'search-1',
      authToken: 'test',
      method: 'aiVault.searchSessions',
      params: { query: 'needle', within: WITHIN }
    })
    expect(service.search).toHaveBeenCalledWith(expect.anything(), {
      kind: 'resolved',
      paths: ['/work/app']
    })
  })

  it('resolves over the relay entry point', async () => {
    const service = fakeSearchService()
    setSessionSearchService(service)
    installSessionSearchScopeCatalogSource(() => CATALOG)
    await relayHandler()({ query: 'needle', within: WITHIN })
    expect(service.search).toHaveBeenCalledWith(expect.anything(), {
      kind: 'resolved',
      paths: ['/work/app']
    })
  })

  it('hands the relay’s own verdict down, that host carrying no repo catalog', async () => {
    const service = fakeSearchService()
    setSessionSearchService(service)
    await relayHandler()({ query: 'needle', within: WITHIN })
    expect(service.search).toHaveBeenCalledWith(
      { query: 'needle', limit: 20 },
      {
        kind: 'unknown'
      }
    )
  })
})

describe('the shared remote client', () => {
  it('carries the identity out across a transport', async () => {
    const service = fakeSearchService()
    setSessionSearchService(service)
    installSessionSearchScopeCatalogSource(() => CATALOG)
    const client = createSessionSearchClient(
      (_method, params) => searchSessionService(params, 'relay'),
      'relay'
    )
    await client.searchSessions({ query: 'needle', within: WITHIN })
    expect(service.search).toHaveBeenCalledWith(expect.anything(), {
      kind: 'resolved',
      paths: ['/work/app']
    })
  })
})
