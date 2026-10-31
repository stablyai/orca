// @vitest-environment happy-dom
import '../../../main/runtime/rpc/unused-default-rpc-methods.test-fixture'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { createProjectGroupingSocketOwner } from '../../../main/persistence/applying-settings/project-grouping-socket-owner.test-fixture'
import {
  closeTestStores,
  createStore,
  readDataFile,
  testState
} from '../../../main/persistence/persistence-test-harness'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('../../../main/telemetry/client', () => ({ track: vi.fn() }))

it.each(['token', 'device-key', 'migration-fallback', 'strict-old'] as const)(
  'authors before debounce through actual %s auth/status, acknowledged and best-effort writers and disk reload',
  async (kind) => {
    const owner = await createProjectGroupingSocketOwner({
      strictOld: kind === 'strict-old',
      response: (method, response) => {
        if (method !== 'status.get' || kind === 'token' || kind === 'device-key') {
          return response
        }
        const parsed = JSON.parse(response)
        if (parsed.ok) {
          parsed.result.capabilities = parsed.result.capabilities.filter((cap: string) =>
            kind === 'strict-old'
              ? cap !== 'ui.project-repo-filter-exact.v1'
              : !cap.startsWith('pairing.device-key')
          )
        }
        return JSON.stringify(parsed)
      }
    })
    const Q = 'runtime:server\0same'
    const priorApi = window.api
    Object.assign(window, { __ORCA_WEB_CLIENT__: true })
    window.localStorage.clear()
    window.sessionStorage.clear()
    window.localStorage.setItem('orca.web.runtimeEnvironment.v1', JSON.stringify(owner.environment))
    vi.stubGlobal('WebSocket', WebSocket)
    vi.resetModules()
    const support = await import('../web/web-device-key-support')
    support.setWebDeviceKeySupportForTests(
      kind === 'device-key' || kind === 'migration-fallback' ? 'session-no-ed25519' : null
    )
    const session = await import('../web/preload-api/web-runtime-session')
    const { createWebUiApi } = await import('../web/preload-api/web-ui-api')
    const { useAppStore } = await import('../store')
    const { usePersistedUIWriter } = await import('./use-persisted-ui-writer')
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    const ui = createWebUiApi()
    Object.assign(window, { api: { ui } })
    const stop = session.subscribeWebRuntimeStatus((snapshot) =>
      useAppStore.getState().applyRuntimeHostStatusSnapshot(snapshot)
    )
    try {
      useAppStore.setState(useAppStore.getInitialState(), true)
      useAppStore.setState({ runtimeEnvironments: [owner.environment] })
      owner.store.updateUI({ filterRepoIds: ['same', Q] })
      await session.getClientForEnvironment(owner.environment).call('status.get')
      await vi.waitFor(() =>
        expect(session.webRuntimeState.activeClient?.statusOwner?.read().verification).toBe(
          'verified'
        )
      )
      // Feed hydration comes from ui.get, not a fabricated support flag or write baseline.
      await act(async () => useAppStore.getState().hydratePersistedUI(await ui.get()))
      function Writer() {
        usePersistedUIWriter()
        return null
      }
      await act(async () => root.render(<Writer />))
      const filterWrites = () =>
        owner.requests.filter(
          (r) => r.method === 'ui.set' && Object.hasOwn(r.params ?? {}, 'filterRepoIds')
        )
      const before = filterWrites().length
      await act(async () =>
        useAppStore.getState().setFilterRepoIds(kind === 'strict-old' ? ['same'] : [Q])
      )
      expect(useAppStore.getState().persistedUIProjectFilterWrite?.intent.exact).toBe(
        kind !== 'strict-old'
      )
      expect(filterWrites()).toHaveLength(before)
      await vi.waitFor(() =>
        expect(owner.store.getUI().filterRepoIds).toEqual(kind === 'strict-old' ? ['same'] : [Q])
      )
      await vi.waitFor(() =>
        expect(useAppStore.getState().persistedUIWriteInFlightCounts).toEqual({})
      )
      const edit = owner.requests.findLast(
        (r) => r.method === 'ui.set' && Object.hasOwn(r.params ?? {}, 'filterRepoIds')
      )
      expect(edit?.params).toEqual(
        kind === 'strict-old'
          ? { filterRepoIds: ['same'] }
          : { filterRepoIds: [Q], filterRepoIdsMode: 'exact' }
      )
      // Same physical client is also used by an old raw writer; it never inherits exact meaning.
      await session.getClientForEnvironment(owner.environment).call('ui.set', { filterRepoIds: [] })
      expect(owner.store.getUI().filterRepoIds).toEqual([])
      await ui.set({ filterRepoIds: kind === 'strict-old' ? ['same'] : [Q] })
      expect(owner.store.getUI().filterRepoIds).toEqual(kind === 'strict-old' ? ['same'] : [Q])
      expect(owner.requests.some((r) => r.method === 'runtime.clientCapabilities.update')).toBe(
        false
      )
      expect(
        owner.auth.every((a) => !a.capabilities.includes('ui.project-repo-filter-exact.v1'))
      ).toBe(true)
      if (kind === 'device-key') {
        expect(owner.requests.filter((r) => r.method === 'pairing.registerDeviceKey')).toHaveLength(
          1
        )
        expect(new Set(owner.auth.map((a) => a.deviceId)).size).toBe(2)
      } else if (kind === 'migration-fallback') {
        expect(owner.auth.length).toBeGreaterThanOrEqual(2)
        expect(new Set(owner.auth.map((a) => a.deviceId)).size).toBe(1)
        expect(owner.requests.filter((r) => r.method === 'pairing.registerDeviceKey')).toHaveLength(
          0
        )
      }
      owner.store.flush()
      expect(readDataFile()).not.toHaveProperty('ui.filterRepoIdsMode')
      expect(JSON.parse(window.localStorage.getItem('orca.web.ui.v1') ?? '{}')).not.toHaveProperty(
        'filterRepoIdsMode'
      )
      await closeTestStores()
      expect(createStore().getUI().filterRepoIds).toEqual(kind === 'strict-old' ? ['same'] : [Q])
    } finally {
      await act(async () => root.unmount())
      container.remove()
      stop()
      session.closeActiveRuntimeClients()
      await owner.close()
      Object.assign(window, { api: priorApi, __ORCA_WEB_CLIENT__: false })
      vi.unstubAllGlobals()
    }
  },
  20_000
)

// Real encrypted owner handshakes and disk reopen run sequentially across three held settlements.
it('fences encrypted A→B→A client cutover across separate owners and obsolete settlements while the successor stays in flight', async () => {
  const delayed: (() => void)[] = []
  let delay = true
  const deliver = (method: string, response: string, reply: (response: string) => void) => {
    if (method === 'ui.set' && delay) {
      delayed.push(() => reply(response))
    } else {
      reply(response)
    }
  }
  const owner = await createProjectGroupingSocketOwner({ deliver })
  const other = await createProjectGroupingSocketOwner({ deliver })
  const bEnvironment = { ...other.environment, id: 'owner-B' }
  window.localStorage.clear()
  window.sessionStorage.clear()
  window.localStorage.setItem('orca.web.runtimeEnvironment.v1', JSON.stringify(owner.environment))
  vi.stubGlobal('WebSocket', WebSocket)
  vi.resetModules()
  const session = await import('../web/preload-api/web-runtime-session')
  const { createWebUiApi } = await import('../web/preload-api/web-ui-api')
  const ui = createWebUiApi()
  const selected = (peer: typeof owner, id: string) =>
    peer.requests.filter((r) => r.method === 'ui.set' && JSON.stringify(r.params).includes(id))
  try {
    const original = session.getClientForEnvironment(owner.environment)
    const a = ui.setWithAck!({ filterRepoIds: ['A-old'] }).catch((error: unknown) => error)
    await vi.waitFor(() => expect(selected(owner, 'A-old')).toHaveLength(1))
    session.webRuntimeState.activeEnvironment = bEnvironment
    const b = ui.setWithAck!({ filterRepoIds: ['B-old'] }).catch((error: unknown) => error)
    await vi.waitFor(() => expect(selected(other, 'B-old')).toHaveLength(1))
    session.webRuntimeState.activeEnvironment = { ...owner.environment, pairingRevision: 2 }
    const c = ui.setWithAck!({ filterRepoIds: ['A-new'] })
    let settled = false
    void c.then(() => {
      settled = true
    })
    await vi.waitFor(() => expect(selected(owner, 'A-new')).toHaveLength(1))
    expect(session.webRuntimeState.activeClient).not.toBe(original)
    expect(delayed).toHaveLength(3)
    delayed[0]()
    delayed[1]()
    expect(await a).toBeInstanceOf(Error)
    expect(await b).toBeInstanceOf(Error)
    expect(settled).toBe(false)
    expect(owner.store.getUI().filterRepoIds).toEqual(['A-new'])
    expect(other.store.getUI().filterRepoIds).toEqual(['B-old'])
    expect(selected(other, 'A-old')).toHaveLength(0)
    expect(selected(other, 'A-new')).toHaveLength(0)
    expect(selected(owner, 'B-old')).toHaveLength(0)
    delayed[2]()
    await c
    expect(settled).toBe(true)
    delay = false
    await ui.setWithAck!({ sortBy: 'name' })
    expect(owner.store.getUI()).toMatchObject({ filterRepoIds: ['A-new'], sortBy: 'name' })
    expect(other.requests.filter((r) => r.method === 'ui.set')).toHaveLength(1)
    owner.store.flush()
    other.store.flush()
    await closeTestStores()
    testState.dir = owner.directory
    expect(createStore().getUI()).toMatchObject({ filterRepoIds: ['A-new'], sortBy: 'name' })
    testState.dir = other.directory
    expect(createStore().getUI().filterRepoIds).toEqual(['B-old'])
  } finally {
    session.closeActiveRuntimeClients()
    delayed.forEach((reply) => reply())
    await owner.close()
    await other.close()
    vi.unstubAllGlobals()
  }
}, 20_000)
