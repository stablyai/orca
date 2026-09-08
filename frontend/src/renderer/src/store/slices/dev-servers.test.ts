import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { DevServer } from '../../../../../shared/dev-server-types'
import { createDevServerSlice, type DevServerSlice } from './dev-servers'
import { callRuntimeRpc } from '../../runtime/runtime-rpc-client'

vi.mock('../../runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: vi.fn()
}))

const callRuntimeRpcMock = vi.mocked(callRuntimeRpc)

// ─── Minimal in-memory store for unit tests ───────────────────────────────────

function makeStore(): DevServerSlice {
  const state: DevServerSlice = {
    devServers: [],
    activeDevServerId: null,
    setDevServers: () => {},
    upsertDevServer: () => {},
    removeDevServer: () => {},
    setActiveDevServerId: () => {},
    updateDevServerStatus: () => {},
    hydrateDevServers: async () => {}
  }
  const set = (
    patch: Partial<DevServerSlice> | ((prev: DevServerSlice) => Partial<DevServerSlice>)
  ) => {
    const next = typeof patch === 'function' ? patch(state) : patch
    Object.assign(state, next)
  }
  const get = () => state as never
  const slice = createDevServerSlice(set as never, get, undefined as never)
  Object.assign(state, slice)
  return state
}

function makeServer(overrides: Partial<DevServer> = {}): DevServer {
  return {
    id: 'ds-test-1',
    name: 'Test Server',
    connectionType: 'relay-ssh',
    status: 'connected',
    platform: 'linux',
    arch: 'x64',
    nodeVersion: '20.0.0',
    lastConnectedAt: Date.now(),
    lastError: null,
    workspaceDir: '/home/user',
    addedAt: Date.now(),
    ...overrides
  }
}

describe('dev-servers slice', () => {
  let store: DevServerSlice

  beforeEach(() => {
    store = makeStore()
  })

  it('setDevServers() replaces the entire list', () => {
    const servers = [makeServer({ id: 'ds-1' }), makeServer({ id: 'ds-2' })]
    store.setDevServers(servers)
    expect(store.devServers).toHaveLength(2)
    expect(store.devServers[0].id).toBe('ds-1')
  })

  it('upsertDevServer() adds a new server when id is not present', () => {
    const s = makeServer({ id: 'ds-new' })
    store.upsertDevServer(s)
    expect(store.devServers).toHaveLength(1)
    expect(store.devServers[0].id).toBe('ds-new')
  })

  it('upsertDevServer() updates existing server when id already present', () => {
    store.upsertDevServer(makeServer({ id: 'ds-1', name: 'Original' }))
    store.upsertDevServer(makeServer({ id: 'ds-1', name: 'Updated' }))
    expect(store.devServers).toHaveLength(1)
    expect(store.devServers[0].name).toBe('Updated')
  })

  it('removeDevServer() removes the correct server', () => {
    store.setDevServers([makeServer({ id: 'ds-1' }), makeServer({ id: 'ds-2' })])
    store.removeDevServer('ds-1')
    expect(store.devServers).toHaveLength(1)
    expect(store.devServers[0].id).toBe('ds-2')
  })

  it('removeDevServer() keeps activeDevServerId when removing a different server', () => {
    store.setDevServers([makeServer({ id: 'ds-1' }), makeServer({ id: 'ds-2' })])
    store.setActiveDevServerId('ds-2')
    store.removeDevServer('ds-1')
    expect(store.activeDevServerId).toBe('ds-2')
  })

  it('removeDevServer() resets activeDevServerId to null when removing the active server', () => {
    store.setDevServers([makeServer({ id: 'ds-active' })])
    store.setActiveDevServerId('ds-active')
    store.removeDevServer('ds-active')
    expect(store.activeDevServerId).toBeNull()
  })

  it('setActiveDevServerId() updates activeDevServerId', () => {
    store.setActiveDevServerId('ds-xyz')
    expect(store.activeDevServerId).toBe('ds-xyz')
  })

  it('updateDevServerStatus() only changes the targeted server', () => {
    store.setDevServers([
      makeServer({ id: 'ds-1', status: 'connected' }),
      makeServer({ id: 'ds-2', status: 'connected' })
    ])
    store.updateDevServerStatus('ds-1', 'error')
    expect(store.devServers.find((ds) => ds.id === 'ds-1')?.status).toBe('error')
    expect(store.devServers.find((ds) => ds.id === 'ds-2')?.status).toBe('connected')
  })

  it('updateDevServerStatus() merges extra fields into the targeted server', () => {
    store.setDevServers([makeServer({ id: 'ds-1', platform: null, lastError: null })])
    store.updateDevServerStatus('ds-1', 'connected', { platform: 'darwin', lastError: null })
    expect(store.devServers[0].platform).toBe('darwin')
    expect(store.devServers[0].status).toBe('connected')
  })
})

describe('hydrateDevServers', () => {
  let store: DevServerSlice

  beforeEach(() => {
    store = makeStore()
    callRuntimeRpcMock.mockReset()
  })

  it('sets devServers from devServer.listForUser on success', async () => {
    const servers = [makeServer({ id: 'ds-1' }), makeServer({ id: 'ds-2' })]
    callRuntimeRpcMock.mockResolvedValue({ devServers: servers })

    await store.hydrateDevServers({ kind: 'local' })

    expect(callRuntimeRpcMock).toHaveBeenCalledWith({ kind: 'local' }, 'devServer.listForUser', {})
    expect(store.devServers.map((s) => s.id)).toEqual(['ds-1', 'ds-2'])
  })

  it('does not crash and leaves devServers untouched when the RPC fails', async () => {
    store.setDevServers([makeServer({ id: 'ds-existing' })])
    callRuntimeRpcMock.mockRejectedValue(new Error('unreachable'))

    await expect(store.hydrateDevServers({ kind: 'local' })).resolves.toBeUndefined()

    expect(store.devServers.map((s) => s.id)).toEqual(['ds-existing'])
  })
})
