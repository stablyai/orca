import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore, testState } from './persistence-test-harness'
import type {
  PtyOwnershipTransferCommitReceipt,
  PtyOwnershipTransferIdentity,
  PtyOwnershipTransferPublicationReceipt
} from '../shared/pty-ownership-transfer-journal'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf-8').slice('encrypted:'.length)
  }
}))

vi.mock('./telemetry/client', () => ({ track: vi.fn() }))
vi.mock('./telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn(() => ({})) }))

const identity: PtyOwnershipTransferIdentity = {
  bridgeId: 'bridge-1',
  terminalId: 'terminal-1',
  incarnationId: 'incarnation-1',
  ownerLease: 'lease-1',
  sourceOwnerGeneration: 3,
  destinationRuntimeId: 'runtime-bun-1'
}

const receipt: PtyOwnershipTransferCommitReceipt = {
  receiptId: 'receipt-1',
  bridgeId: identity.bridgeId,
  acceptedSourceEndSeq: 4,
  committedAt: '2026-08-30T12:03:00.000Z'
}

const publicationReceipt: PtyOwnershipTransferPublicationReceipt = {
  version: 1,
  publicationReceiptId: 'publication-1',
  bridgeId: identity.bridgeId,
  destinationRuntimeId: identity.destinationRuntimeId,
  commitReceipt: receipt,
  publishedAt: '2026-08-30T12:04:00.000Z'
}

beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-pty-ownership-transfer-'))
})

afterEach(() => {
  rmSync(testState.dir, { recursive: true, force: true })
})

describe('PTY ownership transfer journal persistence', () => {
  it('persists source and destination prepares and replays identical requests after restart', async () => {
    const store = createStore()
    const source = store.beginPtyOwnershipTransferSource(identity, 4, {
      now: () => new Date('2026-08-30T12:00:00.000Z')
    })
    const destination = store.beginPtyOwnershipTransferDestination(identity, 4, {
      now: () => new Date('2026-08-30T12:01:00.000Z')
    })
    await store.flushPendingOrThrowAsync()

    const restored = createStore()
    expect(restored.getPtyOwnershipTransferJournal(identity.bridgeId, 'source')).toEqual(source)
    expect(restored.getPtyOwnershipTransferJournal(identity.bridgeId, 'destination')).toEqual(
      destination
    )
    expect(restored.beginPtyOwnershipTransferSource(identity, 4)).toEqual(source)
    expect(() =>
      restored.beginPtyOwnershipTransferSource({ ...identity, terminalId: 'different-terminal' }, 4)
    ).toThrow('pty_ownership_transfer_identity_conflict')
  })

  it('reconciles a committed receipt, publication, and source retirement idempotently', async () => {
    const store = createStore()
    store.beginPtyOwnershipTransferSource(identity, 4)
    store.beginPtyOwnershipTransferDestination(identity, 4)
    const committed = store.markPtyOwnershipTransferDestinationCommitted(identity, receipt)
    expect(store.markPtyOwnershipTransferDestinationCommitted(identity, receipt)).toEqual(committed)
    const observed = store.markPtyOwnershipTransferSourceCommitObserved(identity, receipt)
    expect(store.markPtyOwnershipTransferSourceCommitObserved(identity, receipt)).toEqual(observed)
    const published = store.markPtyOwnershipTransferDestinationPublished(
      identity,
      publicationReceipt
    )
    expect(() => store.retirePtyOwnershipTransferSource(identity)).toThrow(
      'pty_ownership_transfer_source_publication_not_observed'
    )
    const publicationObserved = store.markPtyOwnershipTransferSourcePublicationObserved(
      identity,
      publicationReceipt
    )
    expect(
      store.markPtyOwnershipTransferSourcePublicationObserved(identity, publicationReceipt)
    ).toEqual(publicationObserved)
    const retired = store.retirePtyOwnershipTransferSource(identity, {
      now: () => new Date('2026-08-30T12:05:00.000Z')
    })
    await store.flushPendingOrThrowAsync()

    const restored = createStore()
    expect(restored.getPtyOwnershipTransferJournal(identity.bridgeId, 'destination')).toEqual(
      published
    )
    expect(restored.getPtyOwnershipTransferJournal(identity.bridgeId, 'source')).toEqual(retired)
    expect(restored.retirePtyOwnershipTransferSource(identity)).toEqual(retired)
  })

  it('recovers a lost publication acknowledgement without permitting early retirement', async () => {
    const store = createStore()
    store.beginPtyOwnershipTransferSource(identity, 4)
    store.beginPtyOwnershipTransferDestination(identity, 4)
    store.markPtyOwnershipTransferDestinationCommitted(identity, receipt)
    store.markPtyOwnershipTransferSourceCommitObserved(identity, receipt)
    store.markPtyOwnershipTransferDestinationPublished(identity, publicationReceipt)
    await store.flushPendingOrThrowAsync()

    const afterLostAcknowledgement = createStore()
    expect(() => afterLostAcknowledgement.retirePtyOwnershipTransferSource(identity)).toThrow(
      'pty_ownership_transfer_source_publication_not_observed'
    )
    const destination = afterLostAcknowledgement.getPtyOwnershipTransferJournal(
      identity.bridgeId,
      'destination'
    )
    expect(destination).toMatchObject({ phase: 'published', publicationReceipt })
    if (!destination || destination.side !== 'destination' || !destination.publicationReceipt) {
      throw new Error('expected durable destination publication receipt')
    }
    afterLostAcknowledgement.markPtyOwnershipTransferSourcePublicationObserved(
      identity,
      destination.publicationReceipt
    )
    await afterLostAcknowledgement.flushPendingOrThrowAsync()

    const afterAcknowledgementRecovery = createStore()
    expect(
      afterAcknowledgementRecovery.getPtyOwnershipTransferJournal(identity.bridgeId, 'source')
    ).toMatchObject({ phase: 'publication-observed', publicationReceipt })
    expect(afterAcknowledgementRecovery.retirePtyOwnershipTransferSource(identity)).toMatchObject({
      phase: 'retired',
      publicationReceipt
    })
  })

  it('refuses publication and retirement when the destination cursor trails the source', () => {
    const store = createStore()
    store.beginPtyOwnershipTransferSource(identity, 10)
    store.beginPtyOwnershipTransferDestination(identity, 4)
    store.markPtyOwnershipTransferDestinationCommitted(identity, receipt)
    store.markPtyOwnershipTransferSourceCommitObserved(identity, receipt)
    store.markPtyOwnershipTransferDestinationPublished(identity, publicationReceipt)

    expect(() =>
      store.markPtyOwnershipTransferSourcePublicationObserved(identity, publicationReceipt)
    ).toThrow('pty_ownership_transfer_source_output_not_caught_up')
    expect(() => store.retirePtyOwnershipTransferSource(identity)).toThrow(
      'pty_ownership_transfer_source_publication_not_observed'
    )
  })

  it('advances source and destination cursors monotonically before commit', () => {
    const store = createStore()
    store.beginPtyOwnershipTransferSource(identity, 4)
    store.beginPtyOwnershipTransferDestination(identity, 4)
    expect(store.advancePtyOwnershipTransferSourceOutput(identity, 10)).toMatchObject({
      sourceOutputEndSeq: 10
    })
    expect(store.advancePtyOwnershipTransferDestinationCursor(identity, 10)).toMatchObject({
      acceptedSourceEndSeq: 10
    })
    expect(() => store.advancePtyOwnershipTransferSourceOutput(identity, 9)).toThrow(
      'pty_ownership_transfer_source_cursor_conflict'
    )
    expect(() => store.advancePtyOwnershipTransferDestinationCursor(identity, 9)).toThrow(
      'pty_ownership_transfer_destination_cursor_conflict'
    )
  })

  it('compacts the oldest completed transfer pair before refusing new work', () => {
    const store = createStore()
    for (let index = 0; index < 32; index += 1) {
      const transferIdentity = {
        ...identity,
        bridgeId: `bridge-capacity-${index}`,
        terminalId: `terminal-capacity-${index}`
      }
      store.beginPtyOwnershipTransferSource(transferIdentity, 0)
      store.beginPtyOwnershipTransferDestination(transferIdentity, 0)
      store.abortPtyOwnershipTransfer(transferIdentity, 'source')
      store.abortPtyOwnershipTransfer(transferIdentity, 'destination')
    }
    expect(store.listPtyOwnershipTransferJournals()).toHaveLength(64)
    store.beginPtyOwnershipTransferSource(
      { ...identity, bridgeId: 'bridge-capacity-new', terminalId: 'terminal-capacity-new' },
      0
    )
    expect(store.listPtyOwnershipTransferJournals()).toHaveLength(63)
    expect(store.getPtyOwnershipTransferJournal('bridge-capacity-0', 'source')).toBeNull()
  })

  it('keeps abort tombstones and refuses to abort or reuse committed ownership', () => {
    const store = createStore()
    const source = store.beginPtyOwnershipTransferSource(
      { ...identity, bridgeId: 'bridge-abort' },
      0
    )
    expect(
      store.abortPtyOwnershipTransfer({ ...identity, bridgeId: 'bridge-abort' }, 'source')
    ).toMatchObject({
      phase: 'aborted'
    })
    expect(
      store.abortPtyOwnershipTransfer({ ...identity, bridgeId: 'bridge-abort' }, 'source')
    ).toMatchObject({ phase: 'aborted' })
    expect(() =>
      store.beginPtyOwnershipTransferSource({ ...identity, bridgeId: source.bridgeId }, 0)
    ).toThrow('pty_ownership_transfer_id_aborted')

    store.beginPtyOwnershipTransferDestination(identity, 4)
    store.markPtyOwnershipTransferDestinationCommitted(identity, receipt)
    expect(() => store.abortPtyOwnershipTransfer(identity, 'destination')).toThrow(
      'pty_ownership_transfer_committed_cannot_abort'
    )
  })
})
