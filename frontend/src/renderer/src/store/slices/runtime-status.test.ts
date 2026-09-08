import { afterEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import type { RuntimeStatus } from '../../../../shared/runtime-types'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import { createCompatibleRuntimeStatusResponse } from '../../runtime/runtime-compatibility-test-fixture'
import {
  callRuntimeRpc,
  clearRuntimeCompatibilityCacheForTests
} from '../../runtime/runtime-rpc-client'
import { registerClientStateSettingsAccessor } from '../../runtime/runtime-client-state-client'
import { createRuntimeStatusSlice, mergeById, type RuntimeStatusSlice } from './runtime-status'

const LOCAL_SETTINGS = { activeRuntimeEnvironmentId: null }
const REMOTE_SETTINGS = { activeRuntimeEnvironmentId: 'env-1' }

function createSliceStore(
  settings: typeof LOCAL_SETTINGS | typeof REMOTE_SETTINGS = LOCAL_SETTINGS
) {
  registerClientStateSettingsAccessor(() => settings)
  return create<RuntimeStatusSlice & { settings: typeof settings }>()((...a) => ({
    settings,
    ...createRuntimeStatusSlice(...(a as unknown as Parameters<typeof createRuntimeStatusSlice>))
  }))
}

function makeEnvironment(id: string, name = id): PublicKnownRuntimeEnvironment {
  return {
    id,
    name,
    createdAt: 1,
    updatedAt: 1,
    lastUsedAt: null,
    runtimeId: null,
    endpoints: [{ id: `ws-${id}`, kind: 'websocket', label: 'WebSocket', endpoint: 'ws://x' }],
    preferredEndpointId: `ws-${id}`
  }
}

function makeStatus(overrides: Partial<RuntimeStatus> = {}): RuntimeStatus {
  return {
    runtimeId: 'rt',
    rendererGraphEpoch: 0,
    graphStatus: 'ready',
    authoritativeWindowId: null,
    liveTabCount: 0,
    liveLeafCount: 0,
    runtimeProtocolVersion: 3,
    minCompatibleRuntimeClientVersion: 3,
    ...overrides
  } as RuntimeStatus
}

function stubRuntimeEnvironmentApi({
  getStatus = vi.fn(),
  list = vi.fn(),
  call = vi.fn()
}: {
  getStatus?: ReturnType<typeof vi.fn>
  list?: ReturnType<typeof vi.fn>
  call?: ReturnType<typeof vi.fn>
}) {
  vi.stubGlobal('window', {
    api: {
      runtimeEnvironments: {
        getStatus,
        list,
        call
      }
    }
  })
  return { getStatus, list, call }
}

// Why: routing a clientState.* RPC through an 'environment' target first runs
// the status.get compatibility handshake (see callRuntimeRpc) — this answers
// that handshake compatibly so the actual clientState.get/set mock response
// below it is what the test cares about.
function withStatusHandshake(clientStateResult: unknown) {
  return vi.fn().mockImplementation((args: { method: string }) => {
    if (args.method === 'status.get') {
      return Promise.resolve(createCompatibleRuntimeStatusResponse('env-1'))
    }
    return Promise.resolve({ id: '1', ok: true, result: clientStateResult })
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  clearRuntimeCompatibilityCacheForTests()
  registerClientStateSettingsAccessor(() => LOCAL_SETTINGS)
})

describe('runtime-status slice', () => {
  it('starts with an empty map', () => {
    const store = createSliceStore()
    expect(store.getState().runtimeEnvironments).toEqual([])
    expect(store.getState().runtimeStatusByEnvironmentId.size).toBe(0)
  })

  it('stores saved runtime environments and trims stale statuses', () => {
    const store = createSliceStore()
    store.getState().setRuntimeEnvironmentStatus('keep', { status: makeStatus(), checkedAt: 1 })
    store.getState().setRuntimeEnvironmentStatus('drop', { status: makeStatus(), checkedAt: 1 })

    store.getState().setRuntimeEnvironments([
      {
        id: 'keep',
        name: 'Dev Box',
        createdAt: 1,
        updatedAt: 1,
        lastUsedAt: null,
        runtimeId: null,
        endpoints: [{ id: 'ws-keep', kind: 'websocket', label: 'WebSocket', endpoint: 'ws://x' }],
        preferredEndpointId: 'ws-keep'
      }
    ])

    expect(store.getState().runtimeEnvironments.map((environment) => environment.name)).toEqual([
      'Dev Box'
    ])
    expect(store.getState().runtimeStatusByEnvironmentId.has('keep')).toBe(true)
    expect(store.getState().runtimeStatusByEnvironmentId.has('drop')).toBe(false)
  })

  it('merges per environment id and produces a new map reference', () => {
    const store = createSliceStore()
    const before = store.getState().runtimeStatusByEnvironmentId

    store.getState().setRuntimeEnvironmentStatus('env-a', {
      status: makeStatus(),
      checkedAt: 1
    })
    const afterFirst = store.getState().runtimeStatusByEnvironmentId
    expect(afterFirst).not.toBe(before)
    expect(afterFirst.get('env-a')?.checkedAt).toBe(1)

    store.getState().setRuntimeEnvironmentStatus('env-b', {
      status: null,
      checkedAt: 2
    })
    const afterSecond = store.getState().runtimeStatusByEnvironmentId
    expect(afterSecond.size).toBe(2)
    expect(afterSecond.get('env-a')?.checkedAt).toBe(1)
    expect(afterSecond.get('env-b')?.status).toBeNull()
  })

  it('overwrites the prior entry for the same id', () => {
    const store = createSliceStore()
    store.getState().setRuntimeEnvironmentStatus('env-a', { status: makeStatus(), checkedAt: 1 })
    store.getState().setRuntimeEnvironmentStatus('env-a', { status: null, checkedAt: 5 })

    const map = store.getState().runtimeStatusByEnvironmentId
    expect(map.size).toBe(1)
    expect(map.get('env-a')).toEqual({ status: null, checkedAt: 5 })
  })

  it('clears a single environment entry', () => {
    const store = createSliceStore()
    store.getState().setRuntimeEnvironmentStatus('env-a', { status: makeStatus(), checkedAt: 1 })
    store.getState().setRuntimeEnvironmentStatus('env-b', { status: makeStatus(), checkedAt: 1 })

    store.getState().clearRuntimeEnvironmentStatus('env-a')
    expect(store.getState().runtimeStatusByEnvironmentId.has('env-a')).toBe(false)
    expect(store.getState().runtimeStatusByEnvironmentId.has('env-b')).toBe(true)
  })

  it('no-ops clearing an unknown id without creating a new reference', () => {
    const store = createSliceStore()
    const before = store.getState().runtimeStatusByEnvironmentId
    store.getState().clearRuntimeEnvironmentStatus('missing')
    expect(store.getState().runtimeStatusByEnvironmentId).toBe(before)
  })

  it('retains only saved environment ids', () => {
    const store = createSliceStore()
    store.getState().setRuntimeEnvironmentStatus('keep', { status: makeStatus(), checkedAt: 1 })
    store.getState().setRuntimeEnvironmentStatus('drop', { status: makeStatus(), checkedAt: 1 })

    store.getState().retainRuntimeEnvironmentStatuses(['keep'])
    const map = store.getState().runtimeStatusByEnvironmentId
    expect(map.has('keep')).toBe(true)
    expect(map.has('drop')).toBe(false)
  })

  it('no-ops retain when nothing is dropped', () => {
    const store = createSliceStore()
    store.getState().setRuntimeEnvironmentStatus('keep', { status: makeStatus(), checkedAt: 1 })
    const before = store.getState().runtimeStatusByEnvironmentId

    store.getState().retainRuntimeEnvironmentStatuses(['keep', 'unrelated'])
    expect(store.getState().runtimeStatusByEnvironmentId).toBe(before)
  })

  it('refreshes one runtime environment status and repairs a stale null entry', async () => {
    const getStatus = vi.fn().mockResolvedValue(createCompatibleRuntimeStatusResponse('runtime-a'))
    stubRuntimeEnvironmentApi({ getStatus })
    const store = createSliceStore()
    store.getState().setRuntimeEnvironmentStatus('env-a', { status: null, checkedAt: 1 })

    const reachable = await store.getState().refreshRuntimeEnvironmentStatus('env-a', 5_000)

    expect(reachable).toBe(true)
    expect(getStatus).toHaveBeenCalledWith({ selector: 'env-a', timeoutMs: 5_000 })
    expect(store.getState().runtimeStatusByEnvironmentId.get('env-a')?.status?.runtimeId).toBe(
      'runtime-a'
    )
  })

  it('drops a recent compatibility failure once a status refresh succeeds', async () => {
    clearRuntimeCompatibilityCacheForTests()
    let offline = true
    const call = vi.fn().mockImplementation(({ method }: { method: string }) => {
      if (offline || method === 'status.get') {
        return Promise.resolve(
          offline
            ? {
                id: 'status',
                ok: false,
                error: { code: 'runtime_unavailable', message: 'offline' },
                _meta: { runtimeId: 'runtime-a' }
              }
            : createCompatibleRuntimeStatusResponse('runtime-a')
        )
      }
      return Promise.resolve({ id: method, ok: true, result: { ok: true }, _meta: {} })
    })
    const getStatus = vi.fn().mockResolvedValue(createCompatibleRuntimeStatusResponse('runtime-a'))
    vi.stubGlobal('window', { api: { runtimeEnvironments: { getStatus, call } } })
    const store = createSliceStore()
    const target = { kind: 'environment', environmentId: 'env-a' } as const

    await expect(
      callRuntimeRpc(target, 'repo.list', undefined, { reuseRecentCompatibilityFailure: true })
    ).rejects.toThrow('offline')
    // Reuse-flagged callers stay pinned to the recent failure until recovery.
    await expect(
      callRuntimeRpc(target, 'repo.list', undefined, { reuseRecentCompatibilityFailure: true })
    ).rejects.toThrow('offline')

    offline = false
    await store.getState().refreshRuntimeEnvironmentStatus('env-a')

    await expect(
      callRuntimeRpc(target, 'repo.list', undefined, { reuseRecentCompatibilityFailure: true })
    ).resolves.toEqual({ ok: true })
    clearRuntimeCompatibilityCacheForTests()
  })

  it('drops a recent compatibility failure on a direct non-null status publish', async () => {
    // Why: paths like Settings "Connect" publish the host online via
    // setRuntimeEnvironmentStatus directly (not refreshRuntimeEnvironmentStatus)
    // and then trigger a reuse-flagged repo.list. The stale failure must drop so
    // that reuse-flagged catalog fetch re-probes the now-reachable host.
    clearRuntimeCompatibilityCacheForTests()
    let offline = true
    const call = vi.fn().mockImplementation(({ method }: { method: string }) => {
      if (offline || method === 'status.get') {
        return Promise.resolve(
          offline
            ? {
                id: 'status',
                ok: false,
                error: { code: 'runtime_unavailable', message: 'offline' },
                _meta: { runtimeId: 'runtime-a' }
              }
            : createCompatibleRuntimeStatusResponse('runtime-a')
        )
      }
      return Promise.resolve({ id: method, ok: true, result: { ok: true }, _meta: {} })
    })
    vi.stubGlobal('window', { api: { runtimeEnvironments: { call } } })
    const store = createSliceStore()
    const target = { kind: 'environment', environmentId: 'env-a' } as const

    await expect(
      callRuntimeRpc(target, 'repo.list', undefined, { reuseRecentCompatibilityFailure: true })
    ).rejects.toThrow('offline')

    offline = false
    store.getState().setRuntimeEnvironmentStatus('env-a', { status: makeStatus(), checkedAt: 1 })

    await expect(
      callRuntimeRpc(target, 'repo.list', undefined, { reuseRecentCompatibilityFailure: true })
    ).resolves.toEqual({ ok: true })
    clearRuntimeCompatibilityCacheForTests()
  })

  it('preserves a recent compatibility failure on a null (offline) status publish', async () => {
    // Why: recording an unreachable host must not undermine the fanout fix — a
    // null status is not proof of reachability, so reuse-flagged sweeps keep
    // reusing the one recent failure instead of re-probing per repo.
    clearRuntimeCompatibilityCacheForTests()
    let offline = true
    const call = vi.fn().mockImplementation(({ method }: { method: string }) => {
      if (offline || method === 'status.get') {
        return Promise.resolve(
          offline
            ? {
                id: 'status',
                ok: false,
                error: { code: 'runtime_unavailable', message: 'offline' },
                _meta: { runtimeId: 'runtime-a' }
              }
            : createCompatibleRuntimeStatusResponse('runtime-a')
        )
      }
      return Promise.resolve({ id: method, ok: true, result: { ok: true }, _meta: {} })
    })
    vi.stubGlobal('window', { api: { runtimeEnvironments: { call } } })
    const store = createSliceStore()
    const target = { kind: 'environment', environmentId: 'env-a' } as const

    await expect(
      callRuntimeRpc(target, 'repo.list', undefined, { reuseRecentCompatibilityFailure: true })
    ).rejects.toThrow('offline')

    // A null publish (host still unreachable) must keep the failure pinned even
    // after the transport would answer, so the reuse-flagged caller does not probe.
    offline = false
    store.getState().setRuntimeEnvironmentStatus('env-a', { status: null, checkedAt: 1 })

    await expect(
      callRuntimeRpc(target, 'repo.list', undefined, { reuseRecentCompatibilityFailure: true })
    ).rejects.toThrow('offline')
    clearRuntimeCompatibilityCacheForTests()
  })

  it('records null and returns false when a runtime refresh fails', async () => {
    const getStatus = vi.fn().mockRejectedValue(new Error('closed'))
    stubRuntimeEnvironmentApi({ getStatus })
    const store = createSliceStore()
    store.getState().setRuntimeEnvironmentStatus('env-a', { status: makeStatus(), checkedAt: 1 })

    const reachable = await store.getState().refreshRuntimeEnvironmentStatus('env-a')

    expect(reachable).toBe(false)
    expect(store.getState().runtimeStatusByEnvironmentId.get('env-a')?.status).toBeNull()
  })

  it('hydrates saved environments through the single-environment refresh path', async () => {
    const getStatus = vi.fn().mockResolvedValue(createCompatibleRuntimeStatusResponse('runtime-a'))
    const list = vi.fn().mockResolvedValue([
      {
        id: 'env-a',
        name: 'Dev Box',
        createdAt: 1,
        updatedAt: 1,
        lastUsedAt: null,
        runtimeId: null,
        endpoints: [{ id: 'ws-a', kind: 'websocket', label: 'WebSocket', endpoint: 'ws://x' }],
        preferredEndpointId: 'ws-a'
      }
    ])
    stubRuntimeEnvironmentApi({ getStatus, list })
    const store = createSliceStore()

    await store.getState().hydrateRuntimeEnvironmentStatuses()

    expect(store.getState().runtimeEnvironments.map((environment) => environment.id)).toEqual([
      'env-a'
    ])
    expect(getStatus).toHaveBeenCalledWith({ selector: 'env-a', timeoutMs: 10_000 })
    expect(store.getState().runtimeStatusByEnvironmentId.get('env-a')?.status?.runtimeId).toBe(
      'runtime-a'
    )
  })
})

describe('mergeById (FE-TASK-STORAGE-003)', () => {
  it('does not lose a local server absent from remote', () => {
    const local = [makeEnvironment('a'), makeEnvironment('b')]
    const remote: PublicKnownRuntimeEnvironment[] = []

    expect(mergeById(local, remote)).toEqual(local)
  })

  it('adds a server present in remote but missing locally, without overwriting an existing local deletion', () => {
    // Why: 'b' was deleted on this machine but backend-go (synced from
    // another machine that has not seen the deletion yet) still has it —
    // policy: remote never revives a local deletion, only adds what's
    // genuinely new to this machine ('c').
    const local = [makeEnvironment('a')]
    const remote = [makeEnvironment('a', 'A (renamed remotely)'), makeEnvironment('c')]

    const merged = mergeById(local, remote)

    expect(merged.map((e) => e.id)).toEqual(['a', 'c'])
    // Local copy of 'a' wins — remote does not overwrite existing entries.
    expect(merged.find((e) => e.id === 'a')?.name).toBe('a')
  })
})

describe('setRuntimeEnvironments backend-go sync (FE-TASK-STORAGE-003)', () => {
  it('does not call runtimeClientState when no runtime environment is active', () => {
    const { call } = stubRuntimeEnvironmentApi({})
    const store = createSliceStore(LOCAL_SETTINGS)

    store.getState().setRuntimeEnvironments([makeEnvironment('a')])

    expect(call).not.toHaveBeenCalled()
  })

  it('persists the saved-environment list to backend-go when a runtime environment is active', async () => {
    const call = withStatusHandshake(null)
    stubRuntimeEnvironmentApi({ call })
    const store = createSliceStore(REMOTE_SETTINGS)

    store.getState().setRuntimeEnvironments([makeEnvironment('a')])
    await vi.waitFor(() => {
      expect(call.mock.calls.some(([args]) => args.method === 'clientState.set')).toBe(true)
    })

    const setCall = call.mock.calls.find(([args]) => args.method === 'clientState.set')
    expect(setCall?.[0]).toMatchObject({
      selector: 'env-1',
      method: 'clientState.set',
      params: {
        kind: 'savedRuntimeEnvironments',
        stateJson: JSON.stringify([makeEnvironment('a')])
      }
    })
  })
})

describe('hydrateRuntimeEnvironmentStatuses backend-go merge (FE-TASK-STORAGE-003)', () => {
  it('merges the backend-go saved list into the locally-known list', async () => {
    const list = vi.fn().mockResolvedValue([makeEnvironment('a')])
    const getStatus = vi.fn().mockResolvedValue(createCompatibleRuntimeStatusResponse('runtime-a'))
    const call = withStatusHandshake({
      found: true,
      stateJson: JSON.stringify([makeEnvironment('a'), makeEnvironment('b')])
    })
    stubRuntimeEnvironmentApi({ list, getStatus, call })
    const store = createSliceStore(REMOTE_SETTINGS)

    await store.getState().hydrateRuntimeEnvironmentStatuses()

    expect(
      store
        .getState()
        .runtimeEnvironments.map((e) => e.id)
        .sort()
    ).toEqual(['a', 'b'])
  })

  it('does not query runtimeClientState when no runtime environment is active', async () => {
    const list = vi.fn().mockResolvedValue([makeEnvironment('a')])
    const { call } = stubRuntimeEnvironmentApi({
      list,
      getStatus: vi.fn().mockResolvedValue(createCompatibleRuntimeStatusResponse('runtime-a'))
    })
    const store = createSliceStore(LOCAL_SETTINGS)

    await store.getState().hydrateRuntimeEnvironmentStatuses()

    expect(call).not.toHaveBeenCalled()
    expect(store.getState().runtimeEnvironments.map((e) => e.id)).toEqual(['a'])
  })
})
