import { describe, expect, it } from 'vitest'
import { agentCatalogSync } from './agent-catalog-sync'
import { agentReferenceSync } from './agent-reference-sync'
import type { RpcClient } from './rpc-client'

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

function fakeClient(response: unknown): { client: RpcClient; methods: string[] } {
  return routingClient(() => response)
}

/** Lets a test answer the dedicated read and the legacy piggyback differently. */
function routingClient(route: (method: string) => unknown): {
  client: RpcClient
  methods: string[]
} {
  const methods: string[] = []
  const client = {
    sendRequest: async (method: string) => {
      methods.push(method)
      return route(method)
    },
    getState: () => 'connected'
  } as unknown as RpcClient
  return { client, methods }
}

function catalogResult(revision: number): unknown {
  return {
    ok: true,
    id: '1',
    result: {
      agentCatalog: {
        version: 1,
        revision,
        defaultAgent: 'auto',
        disabledAgents: [],
        customAgents: [],
        deletedCustomAgents: []
      }
    },
    _meta: { runtimeId: 'runtime-1' }
  }
}

function failure(code: string, message = 'nope'): unknown {
  return { ok: false, id: '1', error: { code, message }, _meta: { runtimeId: 'runtime-1' } }
}

describe('agentCatalogSync', () => {
  it('hydrates the catalog snapshot from the dedicated settings.agentCatalog.get read', async () => {
    const { client, methods } = fakeClient(catalogResult(7))
    const conn = agentCatalogSync.openConnection('cat-a', client)
    conn.hydrate()
    await tick()

    expect(methods).toEqual(['settings.agentCatalog.get'])
    expect(agentCatalogSync.getSnapshot('cat-a')).toMatchObject({ version: 1, revision: 7 })

    conn.dispose()
    agentCatalogSync.clear('cat-a')
  })

  it.each(['forbidden', 'method_not_found'])(
    'falls back to the settings.get piggyback when an old host answers %s',
    async (code) => {
      const { client, methods } = routingClient((method) =>
        method === 'settings.agentCatalog.get' ? failure(code) : catalogResult(3)
      )
      const conn = agentCatalogSync.openConnection('cat-old', client)
      conn.hydrate()
      await tick()

      expect(methods).toEqual(['settings.agentCatalog.get', 'settings.get'])
      expect(agentCatalogSync.getSnapshot('cat-old')).toMatchObject({ revision: 3 })

      conn.dispose()
      agentCatalogSync.clear('cat-old')
    }
  )

  it('keeps the cache and skips the fallback when the dedicated read fails transiently', async () => {
    let dedicated: unknown = catalogResult(5)
    const { client, methods } = routingClient((method) =>
      method === 'settings.agentCatalog.get' ? dedicated : catalogResult(9)
    )
    const conn = agentCatalogSync.openConnection('cat-transient', client)
    conn.hydrate()
    await tick()
    expect(agentCatalogSync.getSnapshot('cat-transient')).toMatchObject({ revision: 5 })

    dedicated = failure('internal_error', 'boom')
    methods.length = 0
    conn.announce(6)
    await tick()

    expect(methods).toEqual(['settings.agentCatalog.get'])
    expect(agentCatalogSync.getSnapshot('cat-transient')).toMatchObject({ revision: 5 })

    conn.dispose()
    agentCatalogSync.clear('cat-transient')
  })

  it('drops the cache when a downgraded host answers the dedicated read without a catalog', async () => {
    let result: unknown = catalogResult(5)
    const { client } = routingClient(() => result)
    const conn = agentCatalogSync.openConnection('cat-absent', client)
    conn.hydrate()
    await tick()
    expect(agentCatalogSync.getSnapshot('cat-absent')).toMatchObject({ revision: 5 })

    result = { ok: true, id: '1', result: {}, _meta: { runtimeId: 'runtime-1' } }
    conn.hydrate()
    await tick()

    expect(agentCatalogSync.getSnapshot('cat-absent')).toBeNull()

    conn.dispose()
    agentCatalogSync.clear('cat-absent')
  })

  it('stores the projection error variant so repair copy can render', async () => {
    const { client } = fakeClient({
      ok: true,
      id: '1',
      result: {
        agentCatalog: {
          version: 1,
          revision: 4,
          code: 'agent_catalog_payload_too_large',
          maxBytes: 524_288
        }
      },
      _meta: { runtimeId: 'runtime-1' }
    })
    const conn = agentCatalogSync.openConnection('cat-b', client)
    conn.hydrate()
    await tick()

    expect(agentCatalogSync.getSnapshot('cat-b')).toMatchObject({
      version: 1,
      code: 'agent_catalog_payload_too_large'
    })

    conn.dispose()
    agentCatalogSync.clear('cat-b')
  })

  it('ignores a response missing the agentCatalog field', async () => {
    const { client } = fakeClient({ ok: true, id: '1', result: {}, _meta: { runtimeId: 'r' } })
    const conn = agentCatalogSync.openConnection('cat-c', client)
    conn.hydrate()
    await tick()
    expect(agentCatalogSync.getSnapshot('cat-c')).toBeNull()
    conn.dispose()
    agentCatalogSync.clear('cat-c')
  })
})

describe('agentReferenceSync', () => {
  it('hydrates the reference snapshot from settings.agentReferences.get', async () => {
    const { client, methods } = fakeClient({
      ok: true,
      id: '1',
      result: {
        agentReferences: {
          version: 1,
          revision: 3,
          terminalQuickCommands: []
        }
      },
      _meta: { runtimeId: 'runtime-1' }
    })
    const conn = agentReferenceSync.openConnection('ref-a', client)
    conn.hydrate()
    await tick()

    expect(methods).toEqual(['settings.agentReferences.get'])
    expect(agentReferenceSync.getSnapshot('ref-a')).toMatchObject({ version: 1, revision: 3 })

    conn.dispose()
    agentReferenceSync.clear('ref-a')
  })
})
