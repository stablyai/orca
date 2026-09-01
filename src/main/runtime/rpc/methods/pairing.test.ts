import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { RpcDispatcher } from '../dispatcher'
import { PAIRING_METHODS } from './pairing'
import type { PairingRpcContext } from '../core'

function dispatchPairing(
  method: string,
  params: unknown,
  pairing: PairingRpcContext | undefined
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
  it('registers pairing.createOffer', () => {
    expect(PAIRING_METHODS.map((method) => method.name)).toContain('pairing.createOffer')
  })

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

  it('mints a pairing offer through pairing.createOffer', async () => {
    const createOffer = vi.fn().mockReturnValue({
      available: true,
      pairingUrl: 'orca://pair?code=test',
      endpoint: 'ws://100.64.1.20:6768',
      deviceId: 'device-1',
      webClientUrl: 'http://100.64.1.20:6768/web-index.html#pairing=orca%3A%2F%2Fpair%3Fcode%3Dtest'
    })

    await expect(
      dispatchPairing(
        'pairing.createOffer',
        {
          address: '100.64.1.20',
          name: 'Headless grant',
          rotate: true,
          scope: 'runtime'
        },
        { createOffer }
      )
    ).resolves.toMatchObject({
      ok: true,
      result: {
        available: true,
        pairingUrl: 'orca://pair?code=test',
        endpoint: 'ws://100.64.1.20:6768',
        deviceId: 'device-1',
        webClientUrl:
          'http://100.64.1.20:6768/web-index.html#pairing=orca%3A%2F%2Fpair%3Fcode%3Dtest'
      }
    })
    expect(createOffer).toHaveBeenCalledWith({
      address: '100.64.1.20',
      name: 'Headless grant',
      rotate: true,
      scope: 'runtime'
    })
  })

  it('rejects pairing.createOffer without host minting context', async () => {
    await expect(dispatchPairing('pairing.createOffer', {}, undefined)).resolves.toMatchObject({
      ok: false,
      error: { message: 'pairing_context_unavailable' }
    })
    await expect(
      dispatchPairing('pairing.createOffer', {}, { getEndpoints: vi.fn() })
    ).resolves.toMatchObject({
      ok: false,
      error: { message: 'pairing_context_unavailable' }
    })
  })

  it('rejects injected fields on pairing.createOffer params', async () => {
    const createOffer = vi.fn()
    await expect(
      dispatchPairing(
        'pairing.createOffer',
        { address: '100.64.1.20', deviceToken: 'injected' },
        { createOffer }
      )
    ).resolves.toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    expect(createOffer).not.toHaveBeenCalled()
  })

  it('rejects oversized address on pairing.createOffer', async () => {
    const createOffer = vi.fn()
    await expect(
      dispatchPairing('pairing.createOffer', { address: 'a'.repeat(2049) }, { createOffer })
    ).resolves.toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    expect(createOffer).not.toHaveBeenCalled()
  })
})
