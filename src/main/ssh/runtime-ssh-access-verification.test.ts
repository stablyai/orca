import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createEnvironmentFromPairingOffer } from '../../shared/runtime-environments'
import {
  ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES,
  RUNTIME_PROTOCOL_VERSION
} from '../../shared/protocol-version'
import { RemoteRuntimeClientError } from '../../shared/remote-runtime-client-error'
import { verifyRuntimeEnvironmentSshTunnel } from './runtime-ssh-access-verification'

const send = vi.hoisted(() => vi.fn())
vi.mock('../../shared/remote-runtime-client', () => ({ sendRemoteRuntimeRequest: send }))

const pairing = {
  v: 2 as const,
  endpoint: 'wss://public.example/reverse-proxy/runtime',
  deviceToken: 'existing-device-token',
  publicKeyB64: Buffer.alloc(32, 1).toString('base64'),
  pairedDeviceId: 'existing-paired-client'
}
function environment() {
  return createEnvironmentFromPairingOffer({
    id: 'environment',
    name: 'Existing host',
    now: 1,
    offer: pairing,
    runtimeId: 'host-runtime'
  })
}
function success() {
  return {
    id: 'status',
    ok: true,
    result: {
      runtimeId: 'host-runtime',
      rendererGraphEpoch: 1,
      graphStatus: 'ready',
      authoritativeWindowId: null,
      liveTabCount: 0,
      liveLeafCount: 0,
      runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
      deviceScope: 'runtime',
      pairedDeviceId: 'existing-paired-client'
    },
    _meta: { runtimeId: 'host-runtime' }
  }
}

describe('existing paired host verification over SSH', () => {
  beforeEach(() => {
    send.mockReset().mockResolvedValue(success())
  })

  it('uses the native tunnel listener with the existing E2EE key and grant', async () => {
    const original = environment()
    const signal = new AbortController().signal
    const result = await verifyRuntimeEnvironmentSshTunnel(original, 41000, signal)
    expect(send).toHaveBeenCalledExactlyOnceWith(
      { ...pairing, endpoint: 'ws://127.0.0.1:41000' },
      'status.get',
      undefined,
      15_000,
      undefined,
      signal,
      ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES
    )
    expect(result.verifiedRuntimeId).toBe('host-runtime')
    expect(result.verifiedPairing).toEqual({ ...pairing, endpoint: 'ws://127.0.0.1:41000' })
    expect(original).toEqual(environment())
  })

  it('can learn an unrecorded runtime id only after authenticated status verification', async () => {
    const original = { ...environment(), runtimeId: null }
    expect((await verifyRuntimeEnvironmentSshTunnel(original, 41000)).verifiedRuntimeId).toBe(
      'host-runtime'
    )
    expect(original.runtimeId).toBeNull()
  })

  it.each([0, -1, 65536, 1.5, Number.NaN, Infinity])(
    'rejects invalid bound port %s before contact',
    async (port) => {
      await expect(verifyRuntimeEnvironmentSshTunnel(environment(), port)).rejects.toThrow(
        'valid local port'
      )
      expect(send).not.toHaveBeenCalled()
    }
  )

  it.each(['host-identity', 'access-grant', 'connect'] as const)(
    'does not fallback when %s fails',
    async (pairingStage) => {
      const error = new RemoteRuntimeClientError('unauthorized', 'verification failed', {
        pairingStage
      })
      send.mockRejectedValue(error)
      await expect(verifyRuntimeEnvironmentSshTunnel(environment(), 41000)).rejects.toBe(error)
      expect(send).toHaveBeenCalledTimes(1)
    }
  )

  it('refuses an RPC failure even when it carries the expected runtime metadata', async () => {
    send.mockResolvedValue({
      id: 'status',
      ok: false,
      error: { code: 'unauthorized', message: 'Access revoked' },
      _meta: { runtimeId: 'host-runtime' }
    })
    await expect(verifyRuntimeEnvironmentSshTunnel(environment(), 41000)).rejects.toThrow(
      'Access revoked'
    )
  })

  it.each([
    { runtimeId: 'other-host' },
    { pairedDeviceId: 'other-client' },
    { deviceScope: 'mobile' },
    { minCompatibleRuntimeClientVersion: RUNTIME_PROTOCOL_VERSION + 1 },
    { rendererGraphEpoch: -1 }
  ])(
    'refuses wrong identity, grant scope, compatibility or malformed status: %j',
    async (change) => {
      const response = success()
      send.mockResolvedValue({ ...response, result: { ...response.result, ...change } })
      await expect(verifyRuntimeEnvironmentSshTunnel(environment(), 41000)).rejects.toThrow()
    }
  )

  it('refuses inconsistent runtime identity between status and its envelope', async () => {
    send.mockResolvedValue({ ...success(), _meta: { runtimeId: 'different-runtime' } })
    await expect(verifyRuntimeEnvironmentSshTunnel(environment(), 41000)).rejects.toThrow(
      'runtime identity'
    )
  })

  it('accepts a compatible host that does not publish an optional paired device id', async () => {
    const response = success()
    send.mockResolvedValue({
      ...response,
      result: { ...response.result, pairedDeviceId: undefined }
    })
    expect((await verifyRuntimeEnvironmentSshTunnel(environment(), 41000)).verifiedRuntimeId).toBe(
      'host-runtime'
    )
  })
})
