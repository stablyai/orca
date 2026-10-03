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
    const pairing = { getEndpoints: vi.fn(), getDirectEndpoints: vi.fn(), provisionRelay }

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
    const pairing = { getEndpoints: vi.fn(), getDirectEndpoints: vi.fn(), provisionRelay: vi.fn() }

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

  it('rejects extra keys on pairing.getDirectEndpoints and dispatches an empty object', async () => {
    const getDirectEndpoints = vi.fn().mockResolvedValue({ v: 1, selected: null, endpoints: [] })
    const pairing = { getEndpoints: vi.fn(), getDirectEndpoints, provisionRelay: vi.fn() }

    await expect(
      dispatchPairing('pairing.getDirectEndpoints', { injected: true }, pairing)
    ).resolves.toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    expect(getDirectEndpoints).not.toHaveBeenCalled()

    await expect(dispatchPairing('pairing.getDirectEndpoints', {}, pairing)).resolves.toMatchObject({
      ok: true,
      result: { v: 1, selected: null, endpoints: [] }
    })
    expect(getDirectEndpoints).toHaveBeenCalledWith({})
  })

  it('returns method_not_found on an old desktop that never registered the RPC', async () => {
    const pairing = { getEndpoints: vi.fn(), getDirectEndpoints: vi.fn(), provisionRelay: vi.fn() }
    const result = await new Promise<Record<string, unknown>>((resolve) => {
      const dispatcher = new RpcDispatcher({
        runtime: new OrcaRuntimeService(),
        methods: PAIRING_METHODS.filter((method) => method.name !== 'pairing.getDirectEndpoints')
      })
      void dispatcher.dispatchStreaming(
        { id: 'request-1', authToken: '', method: 'pairing.getDirectEndpoints', params: {} },
        (response) => resolve(JSON.parse(response) as Record<string, unknown>),
        { pairing }
      )
    })
    expect(result).toMatchObject({ ok: false, error: { code: 'method_not_found' } })
    expect(pairing.getDirectEndpoints).not.toHaveBeenCalled()
  })

