import { beforeEach, expect, it, vi } from 'vitest'
import { encodePairingOffer, PAIRING_OFFER_VERSION } from '../../shared/pairing'
import { catalogActivationFixture } from './orcad-catalog-activation-test-fixture'
import { inspectRemoteOrcadCatalogActivation } from './orcad-catalog-activation-client'
const send = vi.hoisted(() => vi.fn())
vi.mock('../../shared/remote-runtime-client', () => ({ sendRemoteRuntimeRequest: send }))
beforeEach(() => {
  send.mockReset()
})
const pairingCode = encodePairingOffer({
  v: PAIRING_OFFER_VERSION,
  endpoint: 'ws://127.0.0.1:46768/runtime',
  deviceToken: 'token',
  publicKeyB64: 'key',
  pairedDeviceId: 'device'
})
function fixture() {
  const f = catalogActivationFixture()
  const response = (result: unknown, runtimeId = f.request.identity.destinationRuntimeId) => ({
    ok: true,
    result,
    _meta: { runtimeId }
  })
  send
    .mockResolvedValueOnce(response({ version: 1, catalogActivation: 1 }))
    .mockResolvedValueOnce(response(f.result))
  const run = () =>
    inspectRemoteOrcadCatalogActivation({
      pairingCode,
      request: f.request,
      signal: new AbortController().signal
    })
  return { ...f, run, response }
}
it('negotiates activation and returns exactly matched evidence without catalog payload', async () => {
  const f = fixture()
  expect(await f.run()).toEqual(f.result)
  expect(send).toHaveBeenCalledTimes(2)
})
it.each([{}, { version: 1 }, { version: 1, catalogActivation: null }])(
  'refuses older hosts before activation %j',
  async (support) => {
    const f = fixture()
    send.mockReset().mockResolvedValue(f.response(support))
    await expect(f.run()).rejects.toThrow('negotiation_required')
    expect(send).toHaveBeenCalledOnce()
  }
)
it.each(['probe', 'activation'])('pins authenticated runtime for %s', async (phase) => {
  const f = fixture()
  send.mockReset()
  if (phase === 'activation') {
    send.mockResolvedValueOnce(f.response({ version: 1, catalogActivation: 1 }))
  }
  send.mockResolvedValueOnce(
    f.response(phase === 'probe' ? { version: 1, catalogActivation: 1 } : f.result, 'wrong-runtime')
  )
  await expect(f.run()).rejects.toThrow('runtime_mismatch')
})
it.each(['catalog', 'publication', 'identity', 'claim'])(
  'rejects mismatched %s evidence',
  async (field) => {
    const f = fixture()
    const result = structuredClone(f.result)
    if (field === 'catalog') {
      result.catalog.manifestSha256 = 'wrong'
    }
    if (field === 'publication') {
      result.publicationReceipt.publicationReceiptId = 'wrong'
    }
    if (field === 'identity') {
      result.identity = { ...result.identity, incarnationId: 'wrong' }
    }
    if (field === 'claim') {
      result.destinationClaim.generation = 0
    }
    send
      .mockReset()
      .mockResolvedValueOnce(f.response({ version: 1, catalogActivation: 1 }))
      .mockResolvedValueOnce(f.response(result))
    await expect(f.run()).rejects.toThrow()
  }
)
