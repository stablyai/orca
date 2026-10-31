import { describe, expect, it, vi } from 'vitest'
import { createHudStore, type HudState } from './hud-store'
import {
  ConnectionStatusController,
  createConnectionStatusInputs,
  probeCompatViaStatusGet,
  type ConnectionStatusInputs
} from './connection-status-state'
import type { ConnectionState, RpcPort, RpcResponse } from '../transport/orca-rpc-wire'

function fixtureState(): HudState {
  return {
    connection: { hostId: null, state: 'disconnected', compat: null },
    hosts: [],
    dashboard: { rows: [], fetchedAt: 0, stale: false },
    inbox: { entries: [] },
    terminalTail: { terminalId: null, lines: [], live: false },
    device: null,
    askInteraction: null,
    nav: { stack: [{ screen: 'pairing' }], exitDialogArmed: false }
  }
}

class FakeRpcPort implements RpcPort {
  calls: { method: string; params?: unknown }[] = []
  statusGetResponse: RpcResponse = {
    id: '1',
    ok: true,
    result: { protocolVersion: 3, minCompatibleMobileVersion: 2 },
    _meta: { runtimeId: 'test' }
  }

  sendRequest(method: string, params?: unknown): Promise<RpcResponse> {
    this.calls.push({ method, params })
    return Promise.resolve(this.statusGetResponse)
  }

  subscribe(): () => void {
    throw new Error('not used by connection-status-state')
  }
}

describe('probeCompatViaStatusGet', () => {
  it('returns ok when desktop satisfies the client compat window', async () => {
    const port = new FakeRpcPort()
    const verdict = await probeCompatViaStatusGet(port)
    expect(verdict).toEqual({ kind: 'ok' })
    expect(port.calls).toEqual([{ method: 'status.get', params: undefined }])
  })

  it('returns blocked when the desktop is too old', async () => {
    const port = new FakeRpcPort()
    port.statusGetResponse = {
      id: '1',
      ok: true,
      result: { protocolVersion: 0, minCompatibleMobileVersion: 0 },
      _meta: { runtimeId: 'test' }
    }
    const verdict = await probeCompatViaStatusGet(port)
    expect(verdict).toEqual({
      kind: 'blocked',
      reason: 'desktop-too-old',
      desktopVersion: 0,
      requiredDesktopVersion: 2
    })
  })

  it('treats a failed status.get as version-0 desktop fields', async () => {
    const port = new FakeRpcPort()
    port.statusGetResponse = {
      id: '1',
      ok: false,
      error: { code: 'x', message: 'x' },
      _meta: { runtimeId: 'test' }
    }
    const verdict = await probeCompatViaStatusGet(port)
    expect(verdict.kind).toBe('blocked')
  })
})

describe('ConnectionStatusController', () => {
  function fakeInputs(probeCompat: ConnectionStatusInputs['probeCompat']) {
    let cb: ((state: ConnectionState) => void) | null = null
    const inputs: ConnectionStatusInputs = {
      onState: (listener) => {
        cb = listener
        return () => {
          cb = null
        }
      },
      probeCompat
    }
    return { inputs, emit: (state: ConnectionState) => cb?.(state) }
  }

  it('updates connection.state and hostId on every state change', () => {
    const store = createHudStore(fixtureState())
    const { inputs, emit } = fakeInputs(() => Promise.resolve({ kind: 'ok' }))
    new ConnectionStatusController(store, inputs).start('host-1')

    emit('connecting')

    expect(store.getState().connection.state).toBe('connecting')
    expect(store.getState().connection.hostId).toBe('host-1')
  })

  it('probes compat and stores the verdict once connected', async () => {
    const store = createHudStore(fixtureState())
    const { inputs, emit } = fakeInputs(() => Promise.resolve({ kind: 'ok' }))
    new ConnectionStatusController(store, inputs).start('host-1')

    emit('connected')
    await Promise.resolve()
    await Promise.resolve()

    expect(store.getState().connection.compat).toEqual({ kind: 'ok' })
  })

  it('stores a blocked verdict from probeCompat', async () => {
    const store = createHudStore(fixtureState())
    const blocked = {
      kind: 'blocked' as const,
      reason: 'desktop-too-old' as const,
      desktopVersion: 0
    }
    const { inputs, emit } = fakeInputs(() => Promise.resolve(blocked))
    new ConnectionStatusController(store, inputs).start('host-1')

    emit('connected')
    await Promise.resolve()
    await Promise.resolve()

    expect(store.getState().connection.compat).toEqual(blocked)
  })

  it('does not probe compat for non-connected states', () => {
    const store = createHudStore(fixtureState())
    const probeCompat = vi.fn(() => Promise.resolve({ kind: 'ok' as const }))
    const { inputs, emit } = fakeInputs(probeCompat)
    new ConnectionStatusController(store, inputs).start('host-1')

    emit('reconnecting')

    expect(probeCompat).not.toHaveBeenCalled()
  })

  it('records lastError when probeCompat rejects', async () => {
    const store = createHudStore(fixtureState())
    const { inputs, emit } = fakeInputs(() => Promise.reject(new Error('boom')))
    new ConnectionStatusController(store, inputs).start('host-1')

    emit('connected')
    await Promise.resolve()
    await Promise.resolve()

    expect(store.getState().connection.lastError).toBe('boom')
  })

  it('finding #6: a disconnect/reconnect invalidates the stale probe — its late result never overwrites the newer episode', async () => {
    const store = createHudStore(fixtureState())
    let resolveFirstProbe!: (verdict: { kind: 'ok' }) => void
    const firstProbe = new Promise<{ kind: 'ok' }>((r) => (resolveFirstProbe = r))
    const probeCompat = vi
      .fn()
      .mockReturnValueOnce(firstProbe)
      .mockReturnValueOnce(
        Promise.resolve({ kind: 'blocked', reason: 'desktop-too-old', desktopVersion: 0 })
      )
    const { inputs, emit } = fakeInputs(probeCompat)
    new ConnectionStatusController(store, inputs).start('host-1')

    emit('connected') // starts the first (slow) probe
    emit('disconnected') // finding #6: must invalidate the in-flight probe above
    emit('connected') // newer episode starts its OWN probe, which resolves first
    await Promise.resolve()
    await Promise.resolve()
    expect(store.getState().connection.compat).toEqual({
      kind: 'blocked',
      reason: 'desktop-too-old',
      desktopVersion: 0
    })

    resolveFirstProbe({ kind: 'ok' }) // the stale first probe finally lands
    await Promise.resolve()
    await Promise.resolve()

    // Must still show the newer episode's verdict, not get clobbered by the stale 'ok'.
    expect(store.getState().connection.compat).toEqual({
      kind: 'blocked',
      reason: 'desktop-too-old',
      desktopVersion: 0
    })
  })

  it('finding #6: disposing the start() subscription invalidates any still-running probe', async () => {
    const store = createHudStore(fixtureState())
    let resolveProbe!: (verdict: { kind: 'ok' }) => void
    const probe = new Promise<{ kind: 'ok' }>((r) => (resolveProbe = r))
    const { inputs, emit } = fakeInputs(() => probe)
    const stop = new ConnectionStatusController(store, inputs).start('host-1')

    emit('connected')
    stop() // host teardown while the probe is still in flight

    resolveProbe({ kind: 'ok' })
    await Promise.resolve()
    await Promise.resolve()

    // The disposed session's probe must never write into the (now stale) connection slice.
    expect(store.getState().connection.compat).toBeNull()
  })

  it('createConnectionStatusInputs wires a real port into probeCompat', async () => {
    const port = new FakeRpcPort()
    const inputs = createConnectionStatusInputs(port, () => () => {})
    const verdict = await inputs.probeCompat()
    expect(verdict).toEqual({ kind: 'ok' })
  })
})
