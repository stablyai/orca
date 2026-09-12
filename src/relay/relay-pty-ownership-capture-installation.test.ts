import { expect, it, vi } from 'vitest'
import type { MethodHandler } from './dispatcher'
import { installRelayPtyOwnershipCapture } from './relay-pty-ownership-capture-installation'
import { context, identity } from './relay-pty-ownership-transfer-delegation-test-fixture'
import { PTY_OWNERSHIP_CAPTURE_METHODS as methods } from '../shared/pty-ownership-capture-wire'
import type { PtySourceDeliverySnapshot } from '../shared/pty-source-credit-contract'

function setup(enabled = true) {
  const handlers = new Map<string, MethodHandler>()
  const lease = { isCurrent: () => true, isDrained: () => true, release: vi.fn() }
  const advertised = vi.fn((value: boolean, selectionEnabled = false, recoveryEnabled = false) => {
    if (value) {
      expect(handlers.size).toBe(recoveryEnabled ? 5 : selectionEnabled ? 4 : 3)
    }
  })
  const delivery: PtySourceDeliverySnapshot = {
    id: identity.terminalId,
    ptyIncarnation: identity.incarnationId,
    ownerGeneration: identity.sourceOwnerGeneration,
    clientGeneration: 1,
    providerGeneration: 1,
    deliveryToken: 'delivery',
    state: 'active',
    windowSu: 256,
    receivedEndSu: 100,
    sentEndSu: 100,
    creditedEndSu: 100,
    exitPublished: false,
    generationClosed: false
  }
  const removeListener = vi.fn()
  const options = {
    enabled,
    handler: {
      beginOwnershipTransferCaptureIngress: vi.fn(() => lease),
      setOwnershipTransferCaptureEnabled: advertised
    },
    sourcePublication: {
      ownershipTransfer: {
        authorizes: vi.fn(() => true),
        inspectDrainedDelivery: vi.fn(() => delivery)
      }
    },
    transfer: {
      inspectPreparedCaptureCursor: vi.fn(() => 20),
      retainCaptureBoundary: vi.fn((_identity, boundary) => boundary)
    },
    dispatcher: {
      onRequest: vi.fn((method: string, handler: MethodHandler) => {
        handlers.set(method, handler)
      }),
      onClientDetached: vi.fn(() => removeListener)
    }
  }
  return { options, handlers, lease, advertised, removeListener }
}

it('composes the real sampler and registry, advertising only after registration', async () => {
  const fixture = setup()
  const dispose = installRelayPtyOwnershipCapture(fixture.options)
  try {
    expect(fixture.advertised).toHaveBeenCalledWith(true)
    expect(() => installRelayPtyOwnershipCapture(fixture.options)).toThrow('already_installed')
    const result = (await fixture.handlers.get(methods.begin)!(
      { version: 1, ...identity, requestId: 'request' },
      context()
    )) as { captureToken: string }
    const evidence = await fixture.handlers.get(methods.inspect)!(
      { version: 1, captureToken: result.captureToken },
      context()
    )
    expect(evidence).toMatchObject({
      version: 1,
      boundary: { identity, throughSeq: 20, delivery: { receivedEndSu: 100 } }
    })
  } finally {
    dispose()
  }
  expect(fixture.advertised.mock.calls).toEqual([[true], [false]])
  expect(fixture.lease.release).toHaveBeenCalledOnce()
  expect(fixture.removeListener).toHaveBeenCalledOnce()
  dispose()
  expect(fixture.advertised).toHaveBeenCalledTimes(2)
})

it('does not install or advertise any capture behavior without opt-in', () => {
  const fixture = setup(false)
  installRelayPtyOwnershipCapture(fixture.options)()
  expect(fixture.handlers.size).toBe(0)
  expect(fixture.advertised).not.toHaveBeenCalled()
})

it('installs selection before advertising it and removes its capability on disposal', () => {
  const fixture = setup()
  const dispose = installRelayPtyOwnershipCapture({
    ...fixture.options,
    enableBaselineSelection: true,
    transfer: { ...fixture.options.transfer, selectCaptureBaseline: vi.fn() }
  })
  expect(fixture.handlers.has(methods.select)).toBe(true)
  expect(fixture.advertised).toHaveBeenCalledWith(true, true, false)
  dispose()
  expect(fixture.advertised.mock.lastCall).toEqual([false])
})

it('refuses selection opt-in without a selection implementation before registering', () => {
  const fixture = setup()
  expect(() =>
    installRelayPtyOwnershipCapture({ ...fixture.options, enableBaselineSelection: true })
  ).toThrow('selection_unavailable')
  expect(fixture.handlers.size).toBe(0)
  expect(fixture.advertised).not.toHaveBeenCalled()
})
it('advertises recovery only after installing its route and revokes it on disposal', async () => {
  const fixture = setup()
  const recover = vi.fn(() => ({ version: 1 as const }))
  const dispose = installRelayPtyOwnershipCapture({
    ...fixture.options,
    enableBaselineSelection: true,
    transfer: {
      ...fixture.options.transfer,
      selectCaptureBaseline: vi.fn(),
      recoverCaptureSelection: recover as never
    }
  })
  expect(fixture.handlers.has(methods.recoverSelection)).toBe(true)
  expect(fixture.advertised).toHaveBeenCalledWith(true, true, true)
  const caller = context(12, 3)
  const params = { version: 1, proof: { saved: true }, baseline: { exact: true } }
  await expect(fixture.handlers.get(methods.recoverSelection)!(params, caller)).resolves.toEqual({
    version: 1,
    baseline: { version: 1 }
  })
  expect(recover).toHaveBeenCalledWith(params.proof, params.baseline, caller)
  dispose()
  await expect(fixture.handlers.get(methods.recoverSelection)!(params, caller)).rejects.toThrow(
    'unavailable'
  )
  expect(recover).toHaveBeenCalledOnce()
  expect(fixture.advertised.mock.lastCall).toEqual([false])
})

it('closes installed registry state if capability advertisement fails', async () => {
  const fixture = setup()
  fixture.advertised.mockImplementation(() => {
    throw new Error('advertisement failed')
  })
  expect(() => installRelayPtyOwnershipCapture(fixture.options)).toThrow('advertisement failed')
  expect(fixture.removeListener).toHaveBeenCalledOnce()
  await expect(
    fixture.handlers.get(methods.begin)!({ version: 1, ...identity, requestId: 'r' }, context())
  ).rejects.toThrow('unavailable')
})
