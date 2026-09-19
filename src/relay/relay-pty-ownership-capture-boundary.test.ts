import { expect, it, vi } from 'vitest'
import { beginRelayPtyOwnershipCaptureBoundary } from './relay-pty-ownership-capture-boundary'
import { context, identity } from './relay-pty-ownership-transfer-delegation-test-fixture'
import type { PtySourceDeliverySnapshot } from '../shared/pty-source-credit-contract'

function setup() {
  const delivery: PtySourceDeliverySnapshot = {
    id: identity.terminalId,
    ptyIncarnation: identity.incarnationId,
    providerGeneration: 1,
    clientGeneration: 1,
    ownerGeneration: identity.sourceOwnerGeneration,
    deliveryToken: 'delivery',
    state: 'active',
    windowSu: 256,
    receivedEndSu: 100,
    sentEndSu: 100,
    creditedEndSu: 100,
    exitPublished: false,
    generationClosed: false
  }
  const lease = { isCurrent: vi.fn(() => true), isDrained: vi.fn(() => true), release: vi.fn() }
  const dependencies = {
    handler: { beginOwnershipTransferCaptureIngress: vi.fn(() => lease) },
    transfer: {
      inspectPreparedCaptureCursor: vi.fn<() => number | null>(() => 20),
      retainCaptureBoundary: vi.fn((_identity, boundary) => boundary)
    },
    source: {
      authorizes: vi.fn(() => true),
      inspectDrainedDelivery: vi.fn<() => PtySourceDeliverySnapshot | null>(() => delivery)
    }
  }
  const requestContext = context()
  return {
    delivery,
    lease,
    dependencies,
    requestContext,
    begin: () => beginRelayPtyOwnershipCaptureBoundary(identity, requestContext, dependencies)
  }
}

it('binds the exact transfer cursor to settled source positions within the same quiet window', () => {
  const fixture = setup()
  const capture = fixture.begin()
  expect(capture.inspect()).toEqual({
    version: 1,
    identity,
    throughSeq: 20,
    delivery: fixture.delivery
  })
  expect(fixture.dependencies.handler.beginOwnershipTransferCaptureIngress).toHaveBeenCalledWith(
    identity.terminalId,
    identity.incarnationId,
    expect.any(Function)
  )
  capture.release()
  capture.release()
  expect(fixture.lease.release).toHaveBeenCalledOnce()
  expect(capture.inspect()).toBeNull()
})

it.each(['stable', 'changed', 'unavailable'])(
  'passes only a stable host raw cursor to boundary issuance: %s',
  (mode) => {
    const fixture = setup()
    const inspectRawCursor = vi.fn<() => number | null>(() => 100)
    if (mode === 'changed') {
      inspectRawCursor.mockReturnValueOnce(100).mockReturnValue(101)
    }
    if (mode === 'unavailable') {
      inspectRawCursor.mockReturnValue(null)
    }
    Object.assign(fixture.lease, { inspectRawCursor })
    const capture = fixture.begin()
    if (mode === 'stable') {
      expect(capture.inspect()).not.toBeNull()
      expect(fixture.dependencies.transfer.retainCaptureBoundary).toHaveBeenCalledWith(
        identity,
        expect.objectContaining({ throughSeq: 20 }),
        100
      )
    } else {
      expect(capture.inspect()).toBeNull()
      expect(fixture.dependencies.transfer.retainCaptureBoundary).not.toHaveBeenCalled()
    }
    capture.release()
  }
)
it('does not return an inspected boundary when its durable attestation fails', () => {
  const fixture = setup()
  fixture.dependencies.transfer.retainCaptureBoundary.mockImplementationOnce(() => {
    throw new Error('boundary persistence failed')
  })
  const capture = fixture.begin()
  expect(() => capture.inspect()).toThrow('boundary persistence failed')
  capture.release()
  expect(fixture.lease.release).toHaveBeenCalledOnce()
})

it.each(['stale', 'unauthenticated', 'throws'])(
  'checks %s authority before reading any boundary evidence',
  (mode) => {
    const fixture = setup()
    const capture = fixture.begin()
    fixture.dependencies.transfer.inspectPreparedCaptureCursor.mockClear()
    if (mode === 'stale') {
      fixture.requestContext.isStale = () => true
    }
    if (mode === 'unauthenticated') {
      fixture.requestContext.sessionIdentity = undefined
    }
    if (mode === 'throws') {
      fixture.dependencies.source.authorizes.mockImplementation(() => {
        throw new Error('unavailable')
      })
    }
    expect(capture.inspect()).toBeNull()
    expect(fixture.dependencies.source.inspectDrainedDelivery).not.toHaveBeenCalled()
    expect(fixture.dependencies.transfer.inspectPreparedCaptureCursor).not.toHaveBeenCalled()
  }
)

it.each(['stale', 'unauthorized', 'unprepared'])(
  'refuses %s capture before pausing ingress',
  (mode) => {
    const fixture = setup()
    if (mode === 'stale') {
      fixture.requestContext.isStale = () => true
    }
    if (mode === 'unauthorized') {
      fixture.dependencies.source.authorizes.mockReturnValue(false)
    }
    if (mode === 'unprepared') {
      fixture.dependencies.transfer.inspectPreparedCaptureCursor.mockReturnValue(null)
    }
    expect(fixture.begin).toThrow('unavailable')
    expect(fixture.dependencies.handler.beginOwnershipTransferCaptureIngress).not.toHaveBeenCalled()
  }
)

it.each(['ingress', 'credit', 'cursor', 'delivery', 'position', 'late-ingress', 'stale'])(
  'refuses a boundary when %s evidence is incomplete or changes',
  (mode) => {
    const fixture = setup()
    const capture = fixture.begin()
    if (mode === 'ingress') {
      fixture.lease.isDrained.mockReturnValue(false)
    }
    if (mode === 'credit') {
      fixture.dependencies.source.inspectDrainedDelivery.mockReturnValue(null)
    }
    if (mode === 'cursor') {
      fixture.dependencies.transfer.inspectPreparedCaptureCursor
        .mockReturnValueOnce(20)
        .mockReturnValueOnce(21)
    }
    if (mode === 'delivery' || mode === 'position') {
      fixture.dependencies.source.inspectDrainedDelivery
        .mockReturnValueOnce(fixture.delivery)
        .mockReturnValueOnce({
          ...fixture.delivery,
          ...(mode === 'delivery' ? { deliveryToken: 'replacement' } : { receivedEndSu: 101 })
        })
    }
    if (mode === 'late-ingress') {
      fixture.lease.isDrained.mockReturnValueOnce(true).mockReturnValueOnce(false)
    }
    if (mode === 'stale') {
      fixture.requestContext.isStale = () => true
    }
    expect(capture.inspect()).toBeNull()
  }
)
