import { beforeEach, expect, it, vi } from 'vitest'
import { encodePairingOffer, PAIRING_OFFER_VERSION } from '../../shared/pairing'
import { catalogActivationFixture } from './orcad-catalog-activation-test-fixture'
import { inspectRemoteOrcadCatalogOutputCoverage } from './orcad-catalog-output-coverage-client'

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
  const result = {
    ...f.result,
    coverage: {
      throughSeq: 2,
      acknowledgedEndSeq: 3,
      modelThroughSeq: 3,
      modelSequenceEnd: 150
    }
  }
  const seed = (value: unknown = result) =>
    send
      .mockReset()
      .mockResolvedValueOnce(response({ version: 1, catalogOutputCoverage: 1 }))
      .mockResolvedValueOnce(response(value))
  seed()
  const run = (throughSeq = 2) =>
    inspectRemoteOrcadCatalogOutputCoverage({
      pairingCode,
      request: { ...f.request, throughSeq },
      signal: new AbortController().signal
    })
  return { ...f, result, response, seed, run }
}

it('negotiates applied coverage separately from activation', async () => {
  const f = fixture()
  expect(await f.run()).toEqual(f.result)
  expect(send.mock.calls.map((call) => call[1])).toEqual([
    'pty.ownershipTransfer.capturedDestinationCapabilities',
    'pty.ownershipTransfer.inspectCapturedCatalogOutputCoverage'
  ])
})

it.each([{}, { version: 1, catalogActivation: 1 }, { version: 1, catalogOutputCoverage: 2 }])(
  'refuses missing or unsupported coverage capability %j',
  async (support) => {
    const f = fixture()
    send.mockReset().mockResolvedValue(f.response(support))
    await expect(f.run()).rejects.toThrow('negotiation_required')
    expect(send).toHaveBeenCalledOnce()
  }
)

it.each(['throughSeq', 'acknowledgedEndSeq', 'modelThroughSeq'] as const)(
  'refuses insufficient or wrong %s',
  async (field) => {
    const f = fixture()
    f.result.coverage[field] = 1
    f.seed()
    await expect(f.run()).rejects.toThrow('coverage_incomplete')
  }
)

it.each(['probe', 'coverage'])('pins destination runtime on %s', async (phase) => {
  const f = fixture()
  send.mockReset()
  if (phase === 'coverage') {
    send.mockResolvedValueOnce(f.response({ version: 1, catalogOutputCoverage: 1 }))
  }
  send.mockResolvedValueOnce(f.response(f.result, 'wrong-runtime'))
  await expect(f.run()).rejects.toThrow('runtime_mismatch')
})

it.each(['activation-only', 'changed-publication'])('rejects %s replies', async (kind) => {
  const f = fixture()
  const { coverage: _coverage, ...activation } = f.result
  f.seed(
    kind === 'activation-only'
      ? activation
      : {
          ...f.result,
          publicationReceipt: { ...f.result.publicationReceipt, publicationReceiptId: 'wrong' }
        }
  )
  await expect(f.run()).rejects.toThrow()
})

it.each([-1, Number.NaN, 1.5, Number.MAX_SAFE_INTEGER + 1])(
  'rejects invalid sequence %s before sending',
  async (seq) => {
    const f = fixture()
    await expect(f.run(seq)).rejects.toThrow()
    expect(send).not.toHaveBeenCalled()
  }
)
