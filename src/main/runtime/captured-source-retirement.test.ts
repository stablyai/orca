import { expect, it, vi } from 'vitest'
import { retireRuntimeCapturedSourceDelivery } from './captured-source-retirement'
import { identity } from '../../relay/relay-pty-ownership-transfer-delegation-test-fixture'
import type { RuntimeCapturedSourceRetirementRequest } from './runtime-ownership-transfer-contracts'

function fixture() {
  const delivery = {
    id: identity.terminalId,
    ptyIncarnation: identity.incarnationId,
    providerGeneration: 2,
    clientGeneration: 3,
    ownerGeneration: identity.sourceOwnerGeneration,
    deliveryToken: 'delivery',
    state: 'active' as const,
    windowSu: 100,
    receivedEndSu: 10,
    sentEndSu: 10,
    creditedEndSu: 10,
    generationClosed: false as const,
    exitPublished: false as const
  }
  const request = {
    identity,
    retirementRecordSha256: 'a'.repeat(64),
    expectedDelivery: delivery,
    signal: new AbortController().signal,
    assertAuthority: vi.fn()
  }
  const result = {
    ...identity,
    version: 1 as const,
    sourceDeliveryRetirement: {
      phase: 'retired' as const,
      retirementRecordSha256: request.retirementRecordSha256,
      delivery
    }
  }
  const retire = vi.fn(async (_request: RuntimeCapturedSourceRetirementRequest) => result)
  const lifecycle = { retirePublishedSourceDelivery: retire, prepareCapturedDestination: vi.fn() }
  const getLifecycle = vi.fn(() => lifecycle)
  const supportsPublication = vi.fn(() => true)
  const options = {
    request,
    runtimeId: identity.destinationRuntimeId,
    getLifecycle,
    supportsPublication
  }
  return {
    options,
    lifecycle,
    retire,
    result,
    run: () => retireRuntimeCapturedSourceDelivery(options)
  }
}

it('binds authority for retirement and expires the callback after completion', async () => {
  const f = fixture()
  expect(await f.run()).toEqual(f.result)
  expect(f.options.request.assertAuthority).toHaveBeenCalled()
  expect(() => f.retire.mock.calls[0][0].assertAuthority()).toThrow('retirement_unavailable')
})

it.each(['unsupported', 'missing-confirmation', 'confirmed'] as const)(
  'gates recovery lifecycle and confirmation: %s',
  async (mode) => {
    const f = fixture()
    Object.assign(f.options.request, { recoveryOnly: true })
    if (mode !== 'unsupported') {
      Object.assign(f.lifecycle, { supportsCapturedSourceRetirementRecovery: () => true })
    }
    if (mode === 'confirmed') {
      Object.assign(f.result, {
        sourceCancellation: { canceled: true, sentEndSu: 10, creditedEndSu: 10 }
      })
    }
    if (mode === 'confirmed') {
      await expect(f.run()).resolves.toHaveProperty('sourceCancellation.canceled', true)
      expect(f.retire.mock.calls[0][0].recoveryOnly).toBe(true)
    } else {
      await expect(f.run()).rejects.toThrow(
        mode === 'unsupported' ? 'unavailable' : 'cancellation_required'
      )
      if (mode === 'unsupported') {
        expect(f.retire).not.toHaveBeenCalled()
      }
    }
  }
)

it.each(['runtime', 'disabled', 'missing', 'hash', 'delivery', 'aborted', 'authority'] as const)(
  'refuses invalid %s before lifecycle mutation',
  async (change) => {
    const f = fixture()
    if (change === 'runtime') {
      f.options.runtimeId = 'other'
    }
    if (change === 'disabled') {
      f.options.supportsPublication.mockReturnValue(false)
    }
    if (change === 'missing') {
      f.options.getLifecycle.mockReturnValue(undefined as never)
    }
    if (change === 'hash') {
      f.options.request.retirementRecordSha256 = 'invalid'
    }
    if (change === 'delivery') {
      f.options.request.expectedDelivery.creditedEndSu--
    }
    if (change === 'aborted') {
      f.options.request.signal = AbortSignal.abort()
    }
    if (change === 'authority') {
      f.options.request.assertAuthority.mockImplementation(() => {
        throw new Error('authority lost')
      })
    }
    await expect(f.run()).rejects.toThrow()
    expect(f.retire).not.toHaveBeenCalled()
  }
)

it.each(['replacement', 'disabled', 'authority', 'response'] as const)(
  'does not acknowledge retirement after %s changes',
  async (change) => {
    const f = fixture()
    f.retire.mockImplementation(async () => {
      if (change === 'replacement') {
        f.options.getLifecycle.mockReturnValue({ ...f.lifecycle })
      }
      if (change === 'disabled') {
        f.options.supportsPublication.mockReturnValue(false)
      }
      if (change === 'authority') {
        f.options.request.assertAuthority.mockImplementation(() => {
          throw new Error('authority lost')
        })
      }
      return change === 'response' ? { ...f.result, bridgeId: 'other' } : f.result
    })
    await expect(f.run()).rejects.toThrow()
    expect(f.retire).toHaveBeenCalledOnce()
  }
)
