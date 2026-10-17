import { describe, expect, it, vi } from 'vitest'
import {
  pairedRuntimeConnectionFromOffer,
  type PairedRuntimeConnection
} from '../shared/paired-runtime-connection'
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

function pairedConnectionFixture(): PairedRuntimeConnection {
  return pairedRuntimeConnectionFromOffer({
    v: 2,
    endpoint: 'ws://192.168.0.25:7400',
    deviceToken: 'token',
    publicKeyB64: 'key'
  })
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
    probe: vi.fn(async () => ({ ok: true })),
    forceRefresh: vi.fn(),
    resolvePairedConnection: vi.fn(pairedConnectionFixture),
    waitForReadyTimeoutMs: 1_000,
    pollIntervalMs: 100,
    probeTimeoutMs: 500,
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
  it('accepts a ready connection that answers the probe without touching the transport', async () => {
    const args = wakeArgs({ getDiagnostics: vi.fn(() => diagnostics('ready')) })

    const result = await ensureEphemeralVmRuntimeControlConnection(args)

    expect(result).toEqual({ ok: true })
    expect(args.probe).toHaveBeenCalledTimes(1)
    expect(args.probe).toHaveBeenCalledWith(ENVIRONMENT_ID, pairedConnectionFixture(), 500)
    expect(args.forceRefresh).not.toHaveBeenCalled()
    expect(args.reconnect).not.toHaveBeenCalled()
    expect(args.ensureConnection).not.toHaveBeenCalled()
    expect(args.sleep).not.toHaveBeenCalled()
  })

  it('refreshes a ready connection whose probe goes unanswered, then waits for ready', async () => {
    let state: RemoteRuntimeSharedConnectionDiagnostics['state'] = 'ready'
    let reads = 0
    const args = wakeArgs({
      getDiagnostics: vi.fn(() => {
        reads += 1
        // The refreshed socket authenticates on the second poll.
        if (state === 'awaiting_ready' && reads > 2) {
          state = 'ready'
        }
        return diagnostics(state)
      }),
      probe: vi.fn(async () => {
        throw new Error('Remote runtime request timed out.')
      }),
      forceRefresh: vi.fn(() => {
        state = 'awaiting_ready'
      })
    })

    const result = await ensureEphemeralVmRuntimeControlConnection(args)

    expect(result).toEqual({ ok: true })
    expect(args.forceRefresh).toHaveBeenCalledTimes(1)
    expect(args.forceRefresh).toHaveBeenCalledWith(ENVIRONMENT_ID)
    expect(args.sleep).toHaveBeenCalledTimes(2)
    expect(args.reconnect).not.toHaveBeenCalled()
    expect(args.ensureConnection).not.toHaveBeenCalled()
  })

  it('reports the terminal state when a refreshed connection never becomes ready', async () => {
    let state: RemoteRuntimeSharedConnectionDiagnostics['state'] = 'ready'
    const args = wakeArgs({
      getDiagnostics: vi.fn(() => diagnostics(state)),
      probe: vi.fn(async () => {
        throw new Error('Remote runtime request timed out.')
      }),
      forceRefresh: vi.fn(() => {
        state = 'awaiting_ready'
      })
    })

    const result = await ensureEphemeralVmRuntimeControlConnection(args)

    expect(result).toEqual({ ok: false, connectionState: 'awaiting_ready' })
    expect(args.forceRefresh).toHaveBeenCalledTimes(1)
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
    expect(args.ensureConnection).toHaveBeenCalledWith(ENVIRONMENT_ID, pairedConnectionFixture())
    expect(args.resolvePairedConnection).toHaveBeenCalledWith('/user-data', ENVIRONMENT_ID)
    expect(args.reconnect).not.toHaveBeenCalled()
    expect(args.probe).not.toHaveBeenCalled()
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
    expect(args.probe).not.toHaveBeenCalled()
    expect(args.forceRefresh).not.toHaveBeenCalled()
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
