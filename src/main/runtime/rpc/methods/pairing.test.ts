import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { RpcDispatcher } from '../dispatcher'
import { PAIRING_METHODS } from './pairing'

function dispatchPairing(
  method: string,
  params: unknown,
  pairing: NonNullable<Parameters<RpcDispatcher['dispatchStreaming']>[2]>['pairing']
): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const dispatcher = new RpcDispatcher({
      runtime: new OrcaRuntimeService(),
      methods: PAIRING_METHODS
    })
    void dispatcher.dispatchStreaming(
      { id: 'request-1', authToken: '', method, params },
      (response) => resolve(JSON.parse(response) as Record<string, unknown>),
      { pairing }
    )
  })
}

describe('pairing RPC methods', () => {
  it('passes only phone-owned credential material to the server-bound provider', async () => {
    const provisionRelay = vi.fn().mockResolvedValue({
      v: 1,
      reqId: 'install-1',
      authorizationMode: 'authenticated-direct',
      currentVersion: 1,
      resumeExpiresAt: Date.now() + 60_000
    })
    const pairing = { getEndpoints: vi.fn(), provisionRelay }

    await expect(
      dispatchPairing(
        'pairing.provisionRelay',
        { reqId: 'install-1', newResumeTokenHash: 'A'.repeat(43) },
        pairing
      )
    ).resolves.toMatchObject({ ok: true })
    expect(provisionRelay).toHaveBeenCalledWith({
      reqId: 'install-1',
      newResumeTokenHash: 'A'.repeat(43)
    })
  })

  it('rejects caller-selected identity and authorization metadata', async () => {
    const pairing = { getEndpoints: vi.fn(), provisionRelay: vi.fn() }

    for (const injected of [
      { relayDeviceId: 'attacker-device' },
      { authorization: { mode: 'relay-basis', basisConnId: 'attacker-basis' } },
      { directAuthId: 'attacker-direct' },
      { acceptedCredentialVersion: 99 }
    ]) {
      await expect(
        dispatchPairing(
          'pairing.provisionRelay',
          { reqId: 'install-1', newResumeTokenHash: 'A'.repeat(43), ...injected },
          pairing
        )
      ).resolves.toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    }
    await expect(
      dispatchPairing(
        'pairing.getEndpoints',
        { installReqId: 'status-1', basisConnId: 'injected' },
        pairing
      )
    ).resolves.toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    expect(pairing.provisionRelay).not.toHaveBeenCalled()
    expect(pairing.getEndpoints).not.toHaveBeenCalled()
  })
})
