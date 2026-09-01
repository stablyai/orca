import { describe, expect, it, vi } from 'vitest'
import {
  mountAgentSync,
  type AgentSyncTarget,
  type AgentSyncTargets
} from './agent-sync-connection'
import type { RpcClient } from './rpc-client'
import type { ConnectionState } from './types'
import type { SnapshotSyncConnection } from './revisioned-snapshot-sync'

type OpenedConnection = { hostId: string; conn: SnapshotSyncConnection }

function createFakeTarget(): { target: AgentSyncTarget; opened: OpenedConnection[] } {
  const opened: OpenedConnection[] = []
  const target: AgentSyncTarget = {
    openConnection: (hostId, _client) => {
      const conn: SnapshotSyncConnection = {
        hydrate: vi.fn(),
        announce: vi.fn(),
        dispose: vi.fn()
      }
      opened.push({ hostId, conn })
      return conn
    },
    clear: vi.fn()
  }
  return { target, opened }
}

function createFakeTargets(): {
  targets: AgentSyncTargets
  catalog: ReturnType<typeof createFakeTarget>
  reference: ReturnType<typeof createFakeTarget>
} {
  const catalog = createFakeTarget()
  const reference = createFakeTarget()
  return { targets: { catalog: catalog.target, reference: reference.target }, catalog, reference }
}

function createFakeClient(initialState: ConnectionState = 'connected'): {
  client: RpcClient
  liveSubscriptions: () => number
  totalSubscriptions: () => number
  sent: string[]
  emit: (data: unknown) => void
  emitState: (state: ConnectionState) => void
} {
  let live = 0
  let total = 0
  let state = initialState
  const sent: string[] = []
  const stateListeners = new Set<(state: ConnectionState) => void>()
  let latestOnData: ((data: unknown) => void) | null = null
  const client = {
    subscribe: (_method: string, _params: unknown, onData: (data: unknown) => void) => {
      total += 1
      live += 1
      latestOnData = onData
      // The server acknowledges the stream with a ready frame carrying an id.
      onData({ type: 'ready', subscriptionId: `sub-${total}` })
      return () => {
        live -= 1
      }
    },
    sendRequest: async (method: string) => {
      sent.push(method)
      return { ok: true, id: 'x', result: {}, _meta: { runtimeId: 'r' } }
    },
    onStateChange: (listener: (state: ConnectionState) => void) => {
      stateListeners.add(listener)
      return () => stateListeners.delete(listener)
    },
    getState: () => state
  } as unknown as RpcClient
  return {
    client,
    liveSubscriptions: () => live,
    totalSubscriptions: () => total,
    sent,
    emit: (data) => latestOnData?.(data),
    emitState: (next) => {
      state = next
      for (const listener of stateListeners) {
        listener(next)
      }
    }
  }
}

describe('mountAgentSync', () => {
  it('keeps exactly one live client-event subscription across 100 replacements, then zero after disposal', () => {
    const fake = createFakeClient()
    const { targets } = createFakeTargets()

    let handle = mountAgentSync(fake.client, 'host', targets)
    for (let i = 0; i < 100; i++) {
      handle.dispose()
      handle = mountAgentSync(fake.client, 'host', targets)
    }
    expect(fake.liveSubscriptions()).toBe(1)
    expect(fake.totalSubscriptions()).toBe(101)

    handle.dispose()
    expect(fake.liveSubscriptions()).toBe(0)
  })

  it('routes catalog and reference change events to the matching cache', () => {
    const fake = createFakeClient()
    const { targets, catalog, reference } = createFakeTargets()
    const handle = mountAgentSync(fake.client, 'host', targets)

    fake.emit({ type: 'agentCatalogChanged', revision: 5 })
    fake.emit({ type: 'agentReferencesChanged', revision: 9 })

    expect(catalog.opened[0]!.conn.announce).toHaveBeenCalledWith(5)
    expect(reference.opened[0]!.conn.announce).toHaveBeenCalledWith(9)
    // Unrelated runtime events do not touch either cache.
    fake.emit({ type: 'worktreesChanged', repoId: 'x' })
    expect(catalog.opened[0]!.conn.announce).toHaveBeenCalledTimes(1)
    expect(reference.opened[0]!.conn.announce).toHaveBeenCalledTimes(1)

    handle.dispose()
  })

  it('hydrates both caches on the initial connected state and again on reconnect', () => {
    const fake = createFakeClient('connecting')
    const { targets, catalog, reference } = createFakeTargets()
    const handle = mountAgentSync(fake.client, 'host', targets)

    // Not connected yet: no hydrate.
    expect(catalog.opened[0]!.conn.hydrate).not.toHaveBeenCalled()

    fake.emitState('connected')
    expect(catalog.opened[0]!.conn.hydrate).toHaveBeenCalledTimes(1)
    expect(reference.opened[0]!.conn.hydrate).toHaveBeenCalledTimes(1)

    // A transient drop then a reconnect performs another full hydrate.
    fake.emitState('reconnecting')
    fake.emitState('connected')
    expect(catalog.opened[0]!.conn.hydrate).toHaveBeenCalledTimes(2)
    expect(reference.opened[0]!.conn.hydrate).toHaveBeenCalledTimes(2)

    handle.dispose()
  })

  it('hydrates immediately when mounted onto an already-connected client', () => {
    const fake = createFakeClient('connected')
    const { targets, catalog } = createFakeTargets()
    const handle = mountAgentSync(fake.client, 'host', targets)

    expect(catalog.opened[0]!.conn.hydrate).toHaveBeenCalledTimes(1)

    handle.dispose()
  })

  it('disposes both sync connections, clears both caches, and unsubscribes the server on dispose', () => {
    const fake = createFakeClient()
    const { targets, catalog, reference } = createFakeTargets()
    const handle = mountAgentSync(fake.client, 'host', targets)

    handle.dispose()

    expect(catalog.opened[0]!.conn.dispose).toHaveBeenCalledTimes(1)
    expect(reference.opened[0]!.conn.dispose).toHaveBeenCalledTimes(1)
    expect(catalog.target.clear).toHaveBeenCalledWith('host')
    expect(reference.target.clear).toHaveBeenCalledWith('host')
    expect(fake.sent).toContain('runtime.clientEvents.unsubscribe')
  })

  it('ignores change events after disposal', () => {
    const fake = createFakeClient()
    const { targets, catalog } = createFakeTargets()
    const handle = mountAgentSync(fake.client, 'host', targets)

    handle.dispose()
    fake.emit({ type: 'agentCatalogChanged', revision: 5 })
    expect(catalog.opened[0]!.conn.announce).not.toHaveBeenCalled()
  })
})
