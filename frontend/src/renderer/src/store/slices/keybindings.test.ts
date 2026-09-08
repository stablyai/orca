import { afterEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import { registerClientStateSettingsAccessor } from '../../runtime/runtime-client-state-client'
import { createKeybindingsSlice, type KeybindingsSlice } from './keybindings'

const LOCAL_SETTINGS = { activeRuntimeEnvironmentId: null }
const REMOTE_SETTINGS = { activeRuntimeEnvironmentId: 'env-1' }

function createSliceStore(settings: typeof LOCAL_SETTINGS | typeof REMOTE_SETTINGS) {
  // Why: runtimeClientState reads settings through a registered accessor (not
  // a direct useAppStore import, to avoid a store <-> runtime circular
  // import — see runtime-client-state-client.ts) — point it at this test's
  // own mini-store instead of the real singleton.
  registerClientStateSettingsAccessor(() => settings)
  return create<KeybindingsSlice & { settings: typeof settings }>()((...a) => ({
    settings,
    ...createKeybindingsSlice(...(a as unknown as Parameters<typeof createKeybindingsSlice>))
  }))
}

function makeFileSnapshot(overrides = {}) {
  return {
    path: '/home/user/.orca/keybindings.json',
    platform: 'linux' as const,
    exists: true,
    overrides,
    commonOverrides: overrides,
    platformOverrides: {},
    diagnostics: []
  }
}

// Why: routing any RPC through an 'environment' target first runs the
// status.get compatibility handshake (see callRuntimeRpc) before the actual
// method — this answers that handshake compatibly so `onOtherMethod` only
// has to handle the RPC the test actually cares about.
function withStatusHandshake(onOtherMethod: (args: { method: string }) => unknown) {
  return vi.fn().mockImplementation((args: { method: string }) => {
    if (args.method === 'status.get') {
      return Promise.resolve({
        id: 'status',
        ok: true,
        result: {
          runtimeId: 'r',
          rendererGraphEpoch: 0,
          graphStatus: 'ready',
          authoritativeWindowId: null,
          liveTabCount: 0,
          liveLeafCount: 0,
          runtimeProtocolVersion: 3,
          minCompatibleRuntimeClientVersion: 3,
          capabilities: []
        },
        _meta: {}
      })
    }
    return Promise.resolve(onOtherMethod(args))
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('keybindings slice — desktop-local (target.kind !== "environment")', () => {
  it('fetchKeybindings still calls window.api.keybindings.get() and applies the snapshot unchanged', async () => {
    const get = vi.fn().mockResolvedValue(makeFileSnapshot({ 'app.settings': ['cmd+,'] }))
    vi.stubGlobal('window', { api: { keybindings: { get } } })
    const store = createSliceStore(LOCAL_SETTINGS)

    await store.getState().fetchKeybindings()

    expect(get).toHaveBeenCalledTimes(1)
    expect(store.getState().keybindings).toEqual({ 'app.settings': ['cmd+,'] })
    expect(store.getState().keybindingSnapshot?.path).toBe('/home/user/.orca/keybindings.json')
  })

  it('setKeybindingOverride still calls window.api.keybindings.setAction, not backend-go', async () => {
    const setAction = vi.fn().mockResolvedValue(makeFileSnapshot({ 'app.settings': ['cmd+k'] }))
    vi.stubGlobal('window', { api: { keybindings: { setAction } } })
    const store = createSliceStore(LOCAL_SETTINGS)

    await store.getState().setKeybindingOverride('app.settings', ['cmd+k'])

    expect(setAction).toHaveBeenCalledWith({ actionId: 'app.settings', bindings: ['cmd+k'] })
    expect(store.getState().keybindings).toEqual({ 'app.settings': ['cmd+k'] })
  })

  it('resetKeybindingOverride still calls setAction with bindings: null', async () => {
    const setAction = vi.fn().mockResolvedValue(makeFileSnapshot({}))
    vi.stubGlobal('window', { api: { keybindings: { setAction } } })
    const store = createSliceStore(LOCAL_SETTINGS)

    await store.getState().resetKeybindingOverride('app.settings')

    expect(setAction).toHaveBeenCalledWith({ actionId: 'app.settings', bindings: null })
  })

  it('disableKeybindingAction still calls setAction with bindings: []', async () => {
    const setAction = vi.fn().mockResolvedValue(makeFileSnapshot({ 'app.settings': [] }))
    vi.stubGlobal('window', { api: { keybindings: { setAction } } })
    const store = createSliceStore(LOCAL_SETTINGS)

    await store.getState().disableKeybindingAction('app.settings')

    expect(setAction).toHaveBeenCalledWith({ actionId: 'app.settings', bindings: [] })
  })
})

describe('keybindings slice — remote (target.kind === "environment")', () => {
  it('seeds backend-go from the local file on first fetch when no remote record exists', async () => {
    const localGet = vi.fn().mockResolvedValue(makeFileSnapshot({ 'app.settings': ['cmd+,'] }))
    const runtimeCall = withStatusHandshake(() => ({ id: '1', ok: true, result: { found: false } }))
    vi.stubGlobal('window', {
      api: {
        keybindings: { get: localGet },
        runtimeEnvironments: { call: runtimeCall }
      }
    })
    const store = createSliceStore(REMOTE_SETTINGS)

    await store.getState().fetchKeybindings()

    expect(localGet).toHaveBeenCalledTimes(1)
    expect(store.getState().keybindings).toEqual({ 'app.settings': ['cmd+,'] })

    // The seed write goes through enqueueWrite/withRetryAndErrorStatus, fired
    // without being awaited by fetchKeybindings — wait for it to land.
    await vi.waitFor(
      () => {
        const setCall = runtimeCall.mock.calls.find(([args]) => args.method === 'clientState.set')
        expect(setCall).toBeDefined()
      },
      { timeout: 10_000 }
    )
    const setCall = runtimeCall.mock.calls.find(([args]) => args.method === 'clientState.set')
    expect(setCall?.[0].params).toEqual({
      kind: 'keybindings',
      stateJson: JSON.stringify({ 'app.settings': ['cmd+,'] })
    })
  })

  it('uses the remote record directly when one already exists, without seeding from local', async () => {
    const localGet = vi.fn()
    const runtimeCall = withStatusHandshake(() => ({
      id: '1',
      ok: true,
      result: { found: true, stateJson: JSON.stringify({ 'app.settings': ['cmd+shift+k'] }) }
    }))
    vi.stubGlobal('window', {
      api: {
        keybindings: { get: localGet },
        runtimeEnvironments: { call: runtimeCall }
      }
    })
    const store = createSliceStore(REMOTE_SETTINGS)

    await store.getState().fetchKeybindings()

    expect(localGet).not.toHaveBeenCalled()
    expect(store.getState().keybindings).toEqual({ 'app.settings': ['cmd+shift+k'] })
    expect(store.getState().keybindingSnapshot).toBeNull()
    expect(runtimeCall.mock.calls.some(([args]) => args.method === 'clientState.set')).toBe(false)
  })

  it('setKeybindingOverride updates local state immediately, writes to backend-go, and never calls window.api.keybindings.setAction', async () => {
    const setAction = vi.fn()
    const runtimeCall = withStatusHandshake(() => ({ id: '1', ok: true, result: null }))
    vi.stubGlobal('window', {
      api: {
        keybindings: { setAction },
        runtimeEnvironments: { call: runtimeCall }
      }
    })
    const store = createSliceStore(REMOTE_SETTINGS)

    await store.getState().setKeybindingOverride('app.settings', ['cmd+k'])

    expect(setAction).not.toHaveBeenCalled()
    expect(store.getState().keybindings).toEqual({ 'app.settings': ['cmd+k'] })

    await vi.waitFor(
      () => {
        const setCall = runtimeCall.mock.calls.find(([args]) => args.method === 'clientState.set')
        expect(setCall).toBeDefined()
      },
      { timeout: 10_000 }
    )
    const setCall = runtimeCall.mock.calls.find(([args]) => args.method === 'clientState.set')
    expect(setCall?.[0].params).toEqual({
      kind: 'keybindings',
      stateJson: JSON.stringify({ 'app.settings': ['cmd+k'] })
    })
  })
})
