import { expect, it, vi } from 'vitest'
import {
  identity,
  preparation,
  source
} from './relay-pty-ownership-transfer-delegation-test-fixture'
import { newRelayPtyOwnershipTransferAdapterState } from './relay-pty-ownership-transfer-adapter-state'
import { persistRelayPtyOwnershipTransfer } from './relay-pty-ownership-transfer-adapter-persistence'
import type { RelayPtyOwnershipTransferDurableRecord } from './relay-pty-ownership-transfer-adapter-contract'
import { encodeRelayPtySourceRetirementJournal } from './relay-pty-source-retirement-journal'
import { decodeRelayPtyOwnershipCaptureJournal } from './relay-pty-ownership-transfer-capture-journal'

const delivery = {
  id: identity.terminalId,
  ptyIncarnation: identity.incarnationId,
  ownerGeneration: identity.sourceOwnerGeneration,
  providerGeneration: 1,
  clientGeneration: 2,
  deliveryToken: 'source-delivery',
  state: 'active' as const,
  windowSu: 256,
  receivedEndSu: 20,
  sentEndSu: 20,
  creditedEndSu: 20,
  generationClosed: false as const,
  exitPublished: false as const
}
const retirement = { phase: 'prepared' as const, retirementRecordSha256: 'a'.repeat(64), delivery }

function base(version: 5 | 6 | 7 | 8 | 9 | 10): RelayPtyOwnershipTransferDurableRecord {
  const boundary = { version: 1 as const, identity, throughSeq: 0, delivery }
  return {
    version,
    identity,
    phase: 'committed',
    destinationDelegation: preparation.destinationDelegation,
    surfacePublication: preparation.surfacePublication,
    destinationOutputRetention: true,
    destinationClaim: { generation: 1, claimId: 'claim' },
    sourceOutputEndSeq: 0,
    replayStartSeq: 1,
    history: { nextSeq: 1, frames: [] },
    acceptedInputs: [],
    acceptedControls: [],
    commitReceipt: {
      bridgeId: identity.bridgeId,
      receiptId: 'commit',
      acceptedSourceEndSeq: 0,
      committedAt: '2026-09-07T00:00:00.000Z'
    },
    ...(version >= 6 ? { destinationInputJournal: true as const, destinationInputs: [] } : {}),
    ...(version >= 7 ? { destinationInputEpoch: 1 } : {}),
    ...(version >= 8 ? { destinationControlJournal: true as const, destinationControls: [] } : {}),
    ...(version >= 9
      ? {
          captureJournalVersion: 8 as const,
          captureBaseline: { version: 1 as const, boundary, modelSha256: 'b'.repeat(64) }
        }
      : {}),
    ...(version === 10 ? { issuedCaptureBoundaries: [boundary] } : {})
  }
}

function fixture(record: RelayPtyOwnershipTransferDurableRecord) {
  let saved = structuredClone(record)
  const setInputFenced = vi.fn()
  const store = {
    loadAll: () => [structuredClone(saved)],
    save: vi.fn((next: RelayPtyOwnershipTransferDurableRecord) => {
      saved = structuredClone(next)
    }),
    remove: vi.fn()
  }
  const restore = () =>
    newRelayPtyOwnershipTransferAdapterState({
      options: {
        store,
        resolveSource: () => source,
        authorizeRequest: () => false,
        setInputFenced,
        writeDestinationInput: vi.fn(),
        publishDestinationOutput: vi.fn()
      }
    })
  return { restore, store, setInputFenced }
}

it.each([5, 6, 7, 8, 9, 10] as const)(
  'round trips retirement phases over journal v%s without restoring connection authority',
  (version) => {
    for (const phase of ['prepared', 'retired'] as const) {
      const record = encodeRelayPtySourceRetirementJournal(base(version), { ...retirement, phase })
      const f = fixture(record)
      const state = f.restore()
      const transfer = state.transfers.get(identity.bridgeId)!
      expect(transfer.sourceDeliveryRetirement).toEqual({ ...retirement, phase })
      expect(transfer.destinationClaimBinding).toBeUndefined()
      expect(transfer.destinationOutputRoute).toBeUndefined()
      expect(f.setInputFenced).toHaveBeenCalledExactlyOnceWith(identity.terminalId, true)
      persistRelayPtyOwnershipTransfer(state, transfer)
      expect(f.store.loadAll()).toEqual([record])
    }
  }
)

it.each([
  { phase: 'unknown' },
  { retirementRecordSha256: '' },
  { retirementRecordSha256: 'A'.repeat(64) },
  { delivery: { ...delivery, id: 'other' } },
  { delivery: { ...delivery, ptyIncarnation: 'other' } },
  { delivery: { ...delivery, ownerGeneration: 99 } },
  { delivery: { ...delivery, creditedEndSu: 19 } },
  { delivery: { ...delivery, sentEndSu: 19 } },
  { delivery: { ...delivery, state: 'closed' } },
  { delivery: { ...delivery, generationClosed: true } },
  { delivery: { ...delivery, exitPublished: true } }
])('rejects invalid or unjoined retirement evidence %#', (patch) => {
  const record = encodeRelayPtySourceRetirementJournal(base(8), retirement)
  const f = fixture({
    ...record,
    sourceDeliveryRetirement: { ...retirement, ...patch }
  } as RelayPtyOwnershipTransferDurableRecord)
  expect(f.restore).toThrow()
  expect(f.setInputFenced).not.toHaveBeenCalled()
  expect(f.store.save).not.toHaveBeenCalled()
})

it.each([
  { version: 8 },
  { retirementJournalVersion: undefined },
  { retirementJournalVersion: 11 },
  { retirementJournalVersion: 4 },
  { sourceDeliveryRetirement: undefined },
  { phase: 'prepared' },
  { destinationClaim: undefined },
  { destinationDelegation: undefined },
  { commitReceipt: undefined }
])('rejects stripped wrappers and missing committed evidence %#', (patch) => {
  const record = encodeRelayPtySourceRetirementJournal(base(8), retirement)
  const f = fixture({ ...record, ...patch } as RelayPtyOwnershipTransferDurableRecord)
  expect(f.restore).toThrow()
  expect(f.setInputFenced).not.toHaveBeenCalled()
})

it('keeps legacy journals unchanged and prevents the previous capture decoder from accepting retirement', () => {
  const legacy = base(10)
  expect(encodeRelayPtySourceRetirementJournal(legacy, undefined)).toBe(legacy)
  expect(() =>
    decodeRelayPtyOwnershipCaptureJournal(encodeRelayPtySourceRetirementJournal(legacy, retirement))
  ).toThrow('journal_invalid')
  expect(
    fixture(legacy).restore().transfers.get(identity.bridgeId)!.sourceDeliveryRetirement
  ).toBeUndefined()
})
