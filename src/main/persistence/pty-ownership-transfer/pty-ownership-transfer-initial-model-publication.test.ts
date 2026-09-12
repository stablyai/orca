import { expect, it, vi } from 'vitest'
import {
  identity,
  preparation
} from '../../../relay/relay-pty-ownership-transfer-delegation-test-fixture'
import { PtyOwnershipTransferSurfacePublicationCoordinator } from './pty-ownership-transfer-surface-publication'
import type { PtyOwnershipInitialModelSnapshot } from './pty-ownership-transfer-initial-model-snapshot'

const seed: PtyOwnershipInitialModelSnapshot = {
  version: 1,
  identity,
  throughSeq: 20,
  modelSequenceEnd: 100,
  modelData: 'retained model',
  cols: 80,
  rows: 24,
  restoreMetadata: { version: 1, kittyKeyboardFlags: 0, cwd: null }
}
const request = {
  identity,
  surfaceBinding: preparation.surfacePublication.surfaceBinding,
  frames: [],
  publicationReceipt: {
    version: 1 as const,
    publicationReceiptId: 'publication-1',
    bridgeId: identity.bridgeId,
    destinationRuntimeId: identity.destinationRuntimeId,
    commitReceipt: {
      bridgeId: identity.bridgeId,
      receiptId: 'commit-1',
      acceptedSourceEndSeq: 20,
      committedAt: '2026-09-06T00:00:00.000Z'
    },
    publishedAt: '2026-09-06T00:00:01.000Z',
    surfaceBinding: preparation.surfacePublication.surfaceBinding
  }
}

it('publishes and retries an exact durable seed without synthesizing replay frames', () => {
  let published = false
  const target = {
    inspectDurablePublication: vi.fn(() =>
      published ? ('published' as const) : ('absent' as const)
    ),
    publishDurably: vi.fn(() => {
      published = true
    })
  }
  const load = vi.fn(() => seed)
  const coordinator = new PtyOwnershipTransferSurfacePublicationCoordinator(target, load)
  expect(coordinator.publish(request)).toEqual(request.publicationReceipt)
  expect(coordinator.publish(request)).toEqual(request.publicationReceipt)
  expect(load).toHaveBeenCalledWith(identity)
  expect(target.publishDurably).toHaveBeenCalledExactlyOnceWith({
    ...request,
    initialModelSnapshot: seed
  })
})

it.each([
  { throughSeq: 19 },
  { throughSeq: 21 },
  { identity: { ...identity, ownerLease: 'different' } },
  { restoreMetadata: undefined },
  { modelData: '' }
])('refuses inconsistent seed evidence before touching the surface: %j', (patch) => {
  const target = { inspectDurablePublication: vi.fn(), publishDurably: vi.fn() }
  const coordinator = new PtyOwnershipTransferSurfacePublicationCoordinator(
    target,
    () => ({ ...seed, ...patch }) as PtyOwnershipInitialModelSnapshot
  )
  expect(() => coordinator.publish(request)).toThrow()
  expect(target.inspectDurablePublication).not.toHaveBeenCalled()
  expect(target.publishDurably).not.toHaveBeenCalled()
})

it('does not accept a caller-provided snapshot in place of the durable resolver', () => {
  const target = { inspectDurablePublication: vi.fn(), publishDurably: vi.fn() }
  const coordinator = new PtyOwnershipTransferSurfacePublicationCoordinator(target)
  const supplied = { ...request, initialModelSnapshot: seed }
  expect(() => coordinator.publish(supplied)).toThrow('does not prove')
  expect(target.inspectDurablePublication).not.toHaveBeenCalled()
})

it('refuses replay alongside the seed instead of publishing duplicate output', () => {
  const target = { inspectDurablePublication: vi.fn(), publishDurably: vi.fn() }
  const coordinator = new PtyOwnershipTransferSurfacePublicationCoordinator(target, () => seed)
  expect(() =>
    coordinator.publish({ ...request, frames: [{ seq: 20, data: 'duplicate' }] })
  ).toThrow('does not prove')
  expect(target.publishDurably).not.toHaveBeenCalled()
})

it('retains durable reread verification for seeded publication', () => {
  const target = { inspectDurablePublication: () => 'absent' as const, publishDurably: vi.fn() }
  const coordinator = new PtyOwnershipTransferSurfacePublicationCoordinator(target, () => seed)
  expect(() => coordinator.publish(request)).toThrow('not durably observable')
})
