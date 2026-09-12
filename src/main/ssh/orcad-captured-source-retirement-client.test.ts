import { beforeEach, expect, it, vi } from 'vitest'
import { encodePairingOffer, PAIRING_OFFER_VERSION } from '../../shared/pairing'
import { catalogActivationFixture } from './orcad-catalog-activation-test-fixture'
import { retireRemoteOrcadCapturedSourceDelivery } from './orcad-captured-source-retirement-client'
const send = vi.hoisted(() => vi.fn())
vi.mock('../../shared/remote-runtime-client', () => ({ sendRemoteRuntimeRequest: send }))
beforeEach(() => send.mockReset())
const pairingCode = encodePairingOffer({
  v: PAIRING_OFFER_VERSION,
  endpoint: 'ws://127.0.0.1:46768/runtime',
  deviceToken: 'token',
  publicKeyB64: 'key',
  pairedDeviceId: 'device'
})

function fixture() {
  const f = catalogActivationFixture()
  const identity = f.request.identity
  const delivery = {
    id: identity.terminalId,
    ptyIncarnation: identity.incarnationId,
    providerGeneration: 2,
    clientGeneration: 3,
    ownerGeneration: identity.sourceOwnerGeneration,
    deliveryToken: 'token',
    state: 'active',
    windowSu: 100,
    receivedEndSu: 10,
    sentEndSu: 10,
    creditedEndSu: 10,
    generationClosed: false,
    exitPublished: false
  }
  const retirementRecordSha256 = 'a'.repeat(64)
  const result = {
    ...identity,
    version: 1,
    sourceDeliveryRetirement: {
      phase: 'retired',
      retirementRecordSha256,
      delivery
    }
  }
  const response = (result: unknown, runtimeId = identity.destinationRuntimeId) => ({
    ok: true,
    result,
    _meta: { runtimeId }
  })
  send
    .mockResolvedValueOnce(response({ version: 1, sourceRetirement: 1 }))
    .mockResolvedValueOnce(response({ ...result, credential: 'secret' }))
  const controller = new AbortController()
  const options = {
    pairingCode,
    request: { ...f.request, retirementRecordSha256, expectedDelivery: delivery },
    signal: controller.signal,
    assertAuthority: vi.fn()
  }
  return {
    options,
    result,
    response,
    controller,
    run: () => retireRemoteOrcadCapturedSourceDelivery(options)
  }
}

it('negotiates before mutation and returns exact sanitized retirement evidence', async () => {
  const f = fixture()
  expect(await f.run()).toEqual(f.result)
  expect(send.mock.calls.map((call) => call[1])).toEqual([
    'pty.ownershipTransfer.capturedDestinationCapabilities',
    'pty.ownershipTransfer.retireCapturedSourceDelivery'
  ])
  expect(send.mock.calls[1][2]).toEqual({ version: 1, ...f.options.request })
})

it.each([undefined, 2, true])(
  'requires exact recovery capability before mutation: %s',
  async (version) => {
    const f = fixture()
    send
      .mockReset()
      .mockResolvedValue(
        f.response({ version: 1, sourceRetirement: 1, sourceRetirementRecovery: version })
      )
    await expect(
      retireRemoteOrcadCapturedSourceDelivery({
        ...f.options,
        request: { ...f.options.request, recoveryOnly: true }
      })
    ).rejects.toThrow('recovery_negotiation_required')
    expect(send).toHaveBeenCalledOnce()
  }
)

it.each(['exact', 'missing', 'cursor'] as const)(
  'validates explicit recovery cancellation: %s',
  async (mode) => {
    const f = fixture()
    const sourceCancellation = {
      canceled: true,
      sentEndSu: mode === 'cursor' ? 11 : 10,
      creditedEndSu: 10
    }
    send
      .mockReset()
      .mockResolvedValueOnce(
        f.response({ version: 1, sourceRetirement: 1, sourceRetirementRecovery: 1 })
      )
      .mockResolvedValueOnce(
        f.response({ ...f.result, ...(mode === 'missing' ? {} : { sourceCancellation }) })
      )
    const result = retireRemoteOrcadCapturedSourceDelivery({
      ...f.options,
      request: { ...f.options.request, recoveryOnly: true }
    })
    await (mode === 'exact'
      ? expect(result).resolves.toMatchObject({ sourceCancellation })
      : expect(result).rejects.toThrow('cancellation_'))
    expect(send.mock.calls[1][2]).toMatchObject({ recoveryOnly: true })
  }
)

it.each([
  {},
  { version: 1 },
  { version: 1, sourceRetirement: 2 },
  { version: 1, sourceRetirement: true }
])('refuses unsupported hosts without mutation %j', async (support) => {
  const f = fixture()
  send.mockReset().mockResolvedValue(f.response(support))
  await expect(f.run()).rejects.toThrow('negotiation_required')
  expect(send).toHaveBeenCalledOnce()
})

it.each(['identity', 'hash', 'delivery'] as const)(
  'rejects mismatched %s response',
  async (field) => {
    const f = fixture()
    const result = structuredClone(f.result)
    if (field === 'identity') {
      result.bridgeId = 'other'
    }
    if (field === 'hash') {
      result.sourceDeliveryRetirement.retirementRecordSha256 = 'b'.repeat(64)
    }
    if (field === 'delivery') {
      result.sourceDeliveryRetirement.delivery.deliveryToken = 'other'
    }
    send
      .mockReset()
      .mockResolvedValueOnce(f.response({ version: 1, sourceRetirement: 1 }))
      .mockResolvedValueOnce(f.response(result))
    await expect(f.run()).rejects.toThrow('response_mismatch')
    expect(send).toHaveBeenCalledTimes(2)
  }
)

it.each(['probe', 'retirement'] as const)(
  'rejects wrong authenticated runtime at %s',
  async (stage) => {
    const f = fixture()
    send.mockReset()
    if (stage === 'retirement') {
      send.mockResolvedValueOnce(f.response({ version: 1, sourceRetirement: 1 }))
    }
    send.mockResolvedValueOnce(f.response(f.result, 'other'))
    await expect(f.run()).rejects.toThrow('runtime_mismatch')
  }
)

it.each(['abort', 'authority'] as const)(
  'refuses %s loss after negotiation before mutation',
  async (kind) => {
    const f = fixture()
    send.mockReset().mockImplementation(async () => {
      if (kind === 'abort') {
        f.controller.abort(new Error('aborted'))
      } else {
        f.options.assertAuthority.mockImplementation(() => {
          throw new Error('authority lost')
        })
      }
      return f.response({ version: 1, sourceRetirement: 1 })
    })
    await expect(f.run()).rejects.toThrow()
    expect(send).toHaveBeenCalledOnce()
  }
)
