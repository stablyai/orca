import { beforeEach, describe, expect, it, vi } from 'vitest'
import { encodePairingOffer, PAIRING_OFFER_VERSION, type PairingOffer } from '../../shared/pairing'
import { RemoteRuntimeClientError } from '../../shared/remote-runtime-client-error'
import type { ServeReadiness } from '../server/serve-readiness'

const verifyRuntimePairingIdentity = vi.hoisted(() =>
  vi.fn<(pairing: PairingOffer, expected: unknown) => Promise<unknown>>()
)
vi.mock('../runtime/runtime-environment-identity-verification', () => ({
  verifyRuntimePairingIdentity
}))

const { classifyOrcadTunnelIdentityFailure, deployedOrcadTunnelChecks } =
  await import('./orcad-managed-tunnel-identity')

function readiness(runtimeId: string, port: number): ServeReadiness {
  const endpoint = `ws://127.0.0.1:${port}`
  return {
    runtimeId,
    boundEndpoint: endpoint,
    advertisedEndpoint: null,
    managedWslCliReconciliation: 'settled',
    pairing: {
      available: true,
      url: encodePairingOffer({
        v: PAIRING_OFFER_VERSION,
        endpoint,
        deviceToken: 'device-token',
        publicKeyB64: 'public-key'
      }),
      endpoint,
      deviceId: 'device-1',
      webClientUrl: null,
      scope: 'runtime',
      qr: null
    }
  }
}

describe('classifyOrcadTunnelIdentityFailure', () => {
  it('reads a runtime that rejected our keys as another server', () => {
    const rejected = new RemoteRuntimeClientError(
      'remote_runtime_unavailable',
      'Remote Orca runtime closed the connection (4001: Unauthorized).',
      { closeCode: 4001 }
    )
    expect(classifyOrcadTunnelIdentityFailure(rejected).verdict).toBe('foreign')
  })

  it('reads a different runtime id as another server', () => {
    const mismatch = new Error('The endpoint does not match this paired runtime identity.')
    expect(classifyOrcadTunnelIdentityFailure(mismatch).verdict).toBe('foreign')
  })

  it.each([
    new RemoteRuntimeClientError(
      'remote_runtime_unavailable',
      'Could not connect to the remote Orca runtime: ECONNREFUSED'
    ),
    new RemoteRuntimeClientError('runtime_timeout', 'Timed out waiting for the remote Orca runtime')
  ])('never reads silence as another server: %s', (error) => {
    expect(classifyOrcadTunnelIdentityFailure(error).verdict).toBe('unreachable')
  })
})

describe('deployedOrcadTunnelChecks', () => {
  beforeEach(() => {
    verifyRuntimePairingIdentity.mockReset()
  })

  it('targets the bound port and verifies the readiness runtime at the tunnel', async () => {
    verifyRuntimePairingIdentity.mockResolvedValue({})
    const checks = deployedOrcadTunnelChecks(readiness('runtime-1', 58_520), vi.fn())
    expect(checks.remotePort).toBe(58_520)
    await expect(checks.verify(41_000)).resolves.toEqual({ verdict: 'verified' })
    const [pairing, expected] = verifyRuntimePairingIdentity.mock.calls[0] ?? []
    expect(pairing?.endpoint).toBe('ws://127.0.0.1:41000/')
    expect(expected).toEqual({ runtimeId: 'runtime-1' })
  })

  it('follows a re-read readiness for both the port and the pairing it verifies', async () => {
    verifyRuntimePairingIdentity.mockResolvedValue({})
    const reread = vi.fn().mockResolvedValue(readiness('runtime-2', 60_001))
    const checks = deployedOrcadTunnelChecks(readiness('runtime-1', 58_520), reread)
    await expect(checks.rereadRemotePort()).resolves.toBe(60_001)
    await checks.verify(41_000)
    expect(verifyRuntimePairingIdentity.mock.calls[0]?.[1]).toEqual({ runtimeId: 'runtime-2' })
    expect(checks.readiness().runtimeId).toBe('runtime-2')
  })

  it('reports a rejecting runtime at the tunnel as foreign', async () => {
    verifyRuntimePairingIdentity.mockRejectedValue(
      new RemoteRuntimeClientError('remote_runtime_unavailable', 'closed', { closeCode: 4001 })
    )
    const checks = deployedOrcadTunnelChecks(readiness('runtime-1', 6_768), vi.fn())
    await expect(checks.verify(41_000)).resolves.toMatchObject({ verdict: 'foreign' })
  })
})

describe('verifyManagedOrcadTunnelIdentity', () => {
  beforeEach(() => {
    verifyRuntimePairingIdentity.mockReset()
  })

  it('proves the server by its pinned key and token, not a per-process runtime id or a stale device id', async () => {
    const { verifyManagedOrcadTunnelIdentity } = await import('./orcad-managed-tunnel-identity')
    verifyRuntimePairingIdentity.mockResolvedValue({})
    const environment = {
      runtimeId: 'runtime-1',
      pairedDeviceId: 'device-old',
      orcadDeployment: { sshTargetId: 't', sshTargetGeneration: 1, localPort: 1, remotePort: 2 },
      preferredEndpointId: 'ws-1',
      endpoints: [
        {
          id: 'ws-1',
          kind: 'websocket',
          label: 'WebSocket',
          endpoint: 'ws://127.0.0.1:1',
          deviceToken: 'token-new',
          publicKeyB64: 'key'
        }
      ]
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the verifier reads only runtimeId, orcadDeployment and the preferred endpoint stubbed here.
    await expect(verifyManagedOrcadTunnelIdentity(environment as never)).resolves.toEqual({
      verdict: 'verified'
    })
    expect(verifyRuntimePairingIdentity.mock.calls[0]?.[1]).toEqual({ runtimeId: null })
  })
})
