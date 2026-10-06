import { describe, expect, it, vi } from 'vitest'
import type { PairingOffer } from '../shared/pairing'
import type { RemoteRuntimeSharedConnectionDiagnostics } from '../shared/remote-runtime-shared-control-types'
import { ensureEphemeralVmRuntimeControlConnection } from './ephemeral-vm-runtime-wake'

const ENVIRONMENT_ID = 'environment-wake'

function diagnostics(
  state: RemoteRuntimeSharedConnectionDiagnostics['state']
): RemoteRuntimeSharedConnectionDiagnostics {
  return {
    state,
    pendingRequestCount: 0,
    subscriptionCount: 0,
    reconnectAttempt: 0,
    lastConnectedAt: null,
    lastClose: null,
    lastError: null
  }
}

function pairingFixture(): PairingOffer {
  return {
    v: 2,
    endpoint: 'ws://192.168.0.25:7400',
    deviceToken: 'token',
    publicKeyB64: 'key'
  } satisfies PairingOffer
}

function wakeArgs(
  overrides: Partial<Parameters<typeof ensureEphemeralVmRuntimeControlConnection>[0]> = {}
) {
  return {
    userDataPath: '/user-data',
    runtimeEnvironmentId: ENVIRONMENT_ID,
    getDiagnostics: vi.fn((): RemoteRuntimeSharedConnectionDiagnostics | null => null),
    reconnect: vi.fn(),
    ensureConnection: vi.fn(),
    resolvePairing: vi.fn(pairingFixture),
    waitForReadyTimeoutMs: 1_000,
    pollIntervalMs: 100,
    now: (() => {
      let current = 0
      return () => {
        current += 100
        return current
      }
    })(),
    sleep: vi.fn(async () => {}),
    ...overrides
  }
}

describe('ensureEphemeralVmRuntimeControlConnection', () => {
  it('accepts an already-ready connection without touching the transport', async () => {
    const args = wakeArgs({ getDiagnostics: vi.fn(() => diagnostics('ready')) })

    const result = await ensureEphemeralVmRuntimeControlConnection(args)

    expect(result).toEqual({ ok: true })
    expect(args.reconnect).not.toHaveBeenCalled()
    expect(args.ensureConnection).not.toHaveBeenCalled()
    expect(args.resolvePairing).not.toHaveBeenCalled()
    expect(args.sleep).not.toHaveBeenCalled()
  })

  it('creates a missing connection from the stored pairing offer', async () => {
    let state: RemoteRuntimeSharedConnectionDiagnostics['state'] | null = null
    const args = wakeArgs({
      getDiagnostics: vi.fn(() => (state === null ? null : diagnostics(state))),
      ensureConnection: vi.fn(() => {
        state = 'ready'
      })
    })

    const result = await ensureEphemeralVmRuntimeControlConnection(args)

    expect(result).toEqual({ ok: true })
    expect(args.ensureConnection).toHaveBeenCalledTimes(1)
    expect(args.ensureConnection).toHaveBeenCalledWith(ENVIRONMENT_ID, pairingFixture())
    expect(args.resolvePairing).toHaveBeenCalledWith('/user-data', ENVIRONMENT_ID)
    expect(args.reconnect).not.toHaveBeenCalled()
  })

  it('forces a reconnect when the cached connection is not ready', async () => {
    const states: (RemoteRuntimeSharedConnectionDiagnostics['state'] | null)[] = [
      'awaiting_ready',
      'awaiting_ready',
      'ready'
    ]
    let read = 0
    const args = wakeArgs({
      getDiagnostics: vi.fn(() => {
        const state = states[Math.min(read, states.length - 1)]
        read += 1
        return state === null ? null : diagnostics(state)
      })
    })

    const result = await ensureEphemeralVmRuntimeControlConnection(args)

    expect(result).toEqual({ ok: true })
    expect(args.reconnect).toHaveBeenCalledTimes(1)
    expect(args.reconnect).toHaveBeenCalledWith(ENVIRONMENT_ID)
    expect(args.ensureConnection).not.toHaveBeenCalled()
  })

  it('reports the terminal state when the connection never becomes ready', async () => {
    const args = wakeArgs({ getDiagnostics: vi.fn(() => diagnostics('awaiting_authenticated')) })

    const result = await ensureEphemeralVmRuntimeControlConnection(args)

    expect(result).toEqual({ ok: false, connectionState: 'awaiting_authenticated' })
    expect(args.reconnect).toHaveBeenCalledTimes(1)
  })

  it('reports a missing connection when nothing was ever cached or created', async () => {
    const args = wakeArgs({
      getDiagnostics: vi.fn((): RemoteRuntimeSharedConnectionDiagnostics | null => null)
    })

    const result = await ensureEphemeralVmRuntimeControlConnection(args)

    expect(result).toEqual({ ok: false, connectionState: 'no_connection' })
    expect(args.ensureConnection).toHaveBeenCalledTimes(1)
  })
})
