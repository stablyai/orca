import { describe, it, expect } from 'vitest'
import type { DevServer } from '../../../../../shared/dev-server-types'
import { createBootstrapSlice, type BootstrapSlice } from './bootstrap'

// ─── Minimal in-memory store for unit tests ───────────────────────────────────
// resumeBootstrapProgressIfAny reads `devServers` off the full AppState via
// `get()` — not part of BootstrapSlice itself — so the fake store carries it
// too, same "as never" pattern dev-servers.test.ts uses for its own
// StateCreator<AppState, ...> cast.

type FakeState = BootstrapSlice & { devServers: DevServer[] }

function makeStore(devServers: DevServer[] = []): FakeState {
  const state: FakeState = {
    bootstrapByServer: {},
    devServers,
    initBootstrap: () => {},
    updateBootstrapStep: () => {},
    appendBootstrapLog: () => {},
    finishBootstrap: () => {},
    clearBootstrap: () => {},
    resumeBootstrapProgressIfAny: () => {}
  }
  const set = (patch: Partial<FakeState> | ((prev: FakeState) => Partial<FakeState>)): void => {
    const next = typeof patch === 'function' ? patch(state) : patch
    Object.assign(state, next)
  }
  const get = () => state as never
  const slice = createBootstrapSlice(set as never, get, undefined as never)
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
    capabilities: null,
    ...overrides
  }
}

describe('resumeBootstrapProgressIfAny', () => {
  let store: FakeState

  it('sets phase=running (no completedAt) when healthStatus is pending', () => {
    store = makeStore([makeServer({ id: 'ds-1', healthStatus: 'pending' })])
    store.resumeBootstrapProgressIfAny('ds-1')
    expect(store.bootstrapByServer['ds-1']?.phase).toBe('running')
    expect(store.bootstrapByServer['ds-1']?.completedAt).toBeNull()
  })

  it('sets phase=done with every step marked done when healthStatus is healthy', () => {
    store = makeStore([makeServer({ id: 'ds-1', healthStatus: 'healthy' })])
    store.resumeBootstrapProgressIfAny('ds-1')
    expect(store.bootstrapByServer['ds-1']?.phase).toBe('done')
    expect(store.bootstrapByServer['ds-1']?.steps.every((s) => s.status === 'done')).toBe(true)
  })

  it.each(['degraded', 'unhealthy'] as const)(
    'does not set any phase when healthStatus is %s',
    (healthStatus) => {
      store = makeStore([makeServer({ id: 'ds-1', healthStatus })])
      store.resumeBootstrapProgressIfAny('ds-1')
      expect(store.bootstrapByServer['ds-1']).toBeUndefined()
    }
  )

  it('does nothing when the dev server has no healthStatus (older backend)', () => {
    store = makeStore([makeServer({ id: 'ds-1' })])
    store.resumeBootstrapProgressIfAny('ds-1')
    expect(store.bootstrapByServer['ds-1']).toBeUndefined()
  })

  it('does nothing when no matching dev server exists', () => {
    store = makeStore([])
    store.resumeBootstrapProgressIfAny('ds-missing')
    expect(store.bootstrapByServer['ds-missing']).toBeUndefined()
  })

  it('never clobbers an already-known bootstrap state (e.g. from live IPC events)', () => {
    store = makeStore([makeServer({ id: 'ds-1', healthStatus: 'healthy' })])
    store.initBootstrap('ds-1')
    store.updateBootstrapStep('ds-1', 'node', { status: 'running' })

    store.resumeBootstrapProgressIfAny('ds-1')

    expect(store.bootstrapByServer['ds-1']?.phase).toBe('running')
    expect(store.bootstrapByServer['ds-1']?.steps.find((s) => s.id === 'node')?.status).toBe(
      'running'
    )
  })
})
