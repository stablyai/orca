import { expect, it, vi } from 'vitest'
import { RETIRE_CAPTURED_SOURCE_DELIVERY_METHOD as method } from './pty-captured-source-retirement'
import { catalogActivationFixture } from '../../../ssh/orcad-catalog-activation-test-fixture'
import type { RpcContext } from '../core'
import type { RuntimeCapturedSourceRetirementRequest } from '../../runtime-ownership-transfer-contracts'
import { ALL_RPC_METHODS } from './index'

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
  const params = {
    version: 1,
    ...f.request,
    retirementRecordSha256: 'a'.repeat(64),
    expectedDelivery: delivery
  }
  const read = vi.fn().mockReturnValue({ state: 'committed', ...f.result.catalog })
  const mutate = vi.fn()
  const retire = vi.fn(async (request: RuntimeCapturedSourceRetirementRequest) => {
    request.assertAuthority()
    request.assertActivation?.(f.activation)
    mutate()
    return { done: true }
  })
  const context: RpcContext = {
    clientKind: 'runtime',
    pairedDeviceId: 'paired',
    connectionId: 'socket',
    signal: new AbortController().signal,
    runtime: {
      supportsCapturedCatalogActivation: () => true,
      supportsCapturedSourceRetirement: () => true,
      getOrcadMigrationCatalogState: read,
      retireCapturedSourceDelivery: retire
    } as never
  }
  const call = (patch: Partial<RpcContext> = {}) =>
    Promise.resolve().then(() =>
      method.handler(method.params!.parse(params), { ...context, ...patch })
    )
  return { ...f, read, retire, mutate, call, params, context }
}

it('refuses unsupported retirement before reading catalog state', async () => {
  const f = fixture()
  f.context.runtime.supportsCapturedSourceRetirement = () => false
  await expect(f.call()).rejects.toThrow('unavailable')
  expect(f.read).not.toHaveBeenCalled()
  expect(f.retire).not.toHaveBeenCalled()
})

it('does not route recovery to an older runtime implementation', async () => {
  const f = fixture()
  Object.assign(f.params, { recoveryOnly: true })
  await expect(f.call()).rejects.toThrow('unavailable')
  expect(f.retire).not.toHaveBeenCalled()
})

it.each([true, false])(
  'requires explicit recovery cancellation confirmation: %s',
  async (confirmed) => {
    const f = fixture()
    Object.assign(f.params, { recoveryOnly: true })
    f.context.runtime.supportsCapturedSourceRetirementRecovery = () => true
    f.retire.mockImplementation(async (request) => {
      expect(request.recoveryOnly).toBe(true)
      return {
        ...f.request.identity,
        version: 1,
        sourceDeliveryRetirement: {
          phase: 'retired',
          retirementRecordSha256: f.params.retirementRecordSha256,
          delivery: f.params.expectedDelivery
        },
        ...(confirmed
          ? { sourceCancellation: { canceled: true, sentEndSu: 10, creditedEndSu: 10 } }
          : {})
      } as never
    })
    await (confirmed
      ? expect(f.call()).resolves.toHaveProperty('sourceCancellation.canceled', true)
      : expect(f.call()).rejects.toThrow('cancellation_required'))
  }
)

it('registers once and requires catalog-bound activation before retirement', async () => {
  const f = fixture()
  expect(ALL_RPC_METHODS.filter((entry) => entry.name === method.name)).toHaveLength(1)
  await expect(f.call()).resolves.toEqual({ done: true })
  expect(f.mutate).toHaveBeenCalledOnce()
  expect(() => f.retire.mock.calls[0][0].assertAuthority()).toThrow('authority_changed')
})

it.each([
  { clientKind: 'mobile' as const },
  { pairedDeviceId: undefined },
  { connectionId: undefined },
  { signal: undefined },
  { signal: AbortSignal.abort() }
])('rejects unauthorized/cancelled caller %j', async (patch) => {
  const f = fixture()
  await expect(f.call(patch)).rejects.toThrow()
  expect(f.retire).not.toHaveBeenCalled()
})

it.each(['staged', 'delivery', 'hash'] as const)(
  'rejects invalid %s before retirement',
  async (change) => {
    const f = fixture()
    if (change === 'staged') {
      f.read.mockReturnValue({ state: 'staged' })
    }
    if (change === 'delivery') {
      f.params.expectedDelivery.creditedEndSu--
    }
    if (change === 'hash') {
      f.params.retirementRecordSha256 = 'invalid'
    }
    await expect(f.call()).rejects.toThrow()
    expect(f.retire).not.toHaveBeenCalled()
  }
)

it.each(['catalog', 'publication', 'admission'] as const)(
  'refuses changed %s before source mutation',
  async (change) => {
    const f = fixture()
    f.retire.mockImplementation(async (request) => {
      if (change === 'catalog') {
        f.read.mockReturnValue({ state: 'absent' })
      }
      const activation = structuredClone(f.activation)
      if (change === 'publication') {
        activation.publicationReceipt.publicationReceiptId = 'other'
      }
      if (change === 'admission') {
        activation.catalogAdmission = null as never
      }
      request.assertActivation!(activation)
      f.mutate()
      return { done: true }
    })
    await expect(f.call()).rejects.toThrow()
    expect(f.mutate).not.toHaveBeenCalled()
  }
)

it('refuses completion after catalog changes during retirement', async () => {
  const f = fixture()
  f.retire.mockImplementation(async () => {
    f.read.mockReturnValue({ state: 'absent' })
    return { done: true }
  })
  await expect(f.call()).rejects.toThrow('authority_changed')
})
