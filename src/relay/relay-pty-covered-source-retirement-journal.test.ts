import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { RelayPtyOwnershipTransferFileStore } from './relay-pty-ownership-transfer-file-store'
import {
  identity,
  preparation,
  source,
  makeDelegatedRelay
} from './relay-pty-ownership-transfer-delegation-test-fixture'
import { parsePtyOwnershipCaptureBaseline } from '../shared/pty-ownership-capture-baseline'
import { newRelayPtyOwnershipTransferAdapterState } from './relay-pty-ownership-transfer-adapter-state'
import { persistRelayPtyOwnershipTransfer } from './relay-pty-ownership-transfer-adapter-persistence'
import { observeRelayPtyOwnershipTransferOutput } from './relay-pty-ownership-transfer-output-observation'
import type { RelayPtyOwnershipTransferDurableRecord } from './relay-pty-ownership-transfer-adapter-contract'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function fixture(phase: 'prepared' | 'retired' = 'prepared', zeroDisplayOnly = false) {
  const directory = mkdtempSync(join(tmpdir(), 'orca-covered-journal-'))
  directories.push(directory)
  const store = new RelayPtyOwnershipTransferFileStore(directory)
  const options = {
    store,
    enableDestinationOutputRetention: true,
    resolveTerminalIncarnation: () => identity.incarnationId,
    hasPendingSourceOutput: () => false,
    resolveSource: () => source,
    authorizeRequest: () => false,
    setInputFenced: vi.fn(),
    writeDestinationInput: vi.fn(),
    publishDestinationOutput: vi.fn()
  }
  const relay = makeDelegatedRelay(store, options)
  relay.prepare(preparation)
  const baseline = parsePtyOwnershipCaptureBaseline(
    {
      version: 1,
      modelSha256: 'a'.repeat(64),
      boundary: {
        version: 1,
        identity,
        throughSeq: 0,
        delivery: {
          id: identity.terminalId,
          ptyIncarnation: identity.incarnationId,
          providerGeneration: 1,
          clientGeneration: 1,
          ownerGeneration: identity.sourceOwnerGeneration,
          deliveryToken: 'captured',
          state: 'active',
          windowSu: 1024,
          receivedEndSu: 500,
          sentEndSu: 500,
          creditedEndSu: 500,
          exitPublished: false,
          generationClosed: false
        }
      }
    },
    identity
  )
  relay.retainCaptureBoundary(identity, baseline.boundary, 112)
  relay.selectCaptureBaseline(identity, baseline, () => baseline.boundary)
  const emissions = zeroDisplayOnly
    ? ([['', 112, 140]] as const)
    : ([
        ['one🙂', 112, 134],
        ['', 134, 140]
      ] as const)
  for (const [data, start, end] of emissions) {
    relay.observeOutput(identity.terminalId, data, `${start}:${end}`, undefined, {
      emissionId: `${start}:${end}`,
      rawStartSu: start,
      rawEndSu: end,
      displayStartSu: 0,
      displayEndSu: data.length,
      displayLengthSu: data.length
    })
  }
  const reopen = () => newRelayPtyOwnershipTransferAdapterState({ options })
  const state = reopen()
  const transfer = state.transfers.get(identity.bridgeId)!
  // Model commit custody here; authenticated commit execution is covered separately.
  transfer.phase = 'committed'
  transfer.destinationClaim = { generation: 1, claimId: 'claim' }
  transfer.committedSourceOutputEndSeq = transfer.sourceOutputEndSeq
  transfer.commitReceipt = {
    bridgeId: identity.bridgeId,
    receiptId: 'receipt',
    acceptedSourceEndSeq: 0,
    committedAt: '2026-09-08T00:00:00.000Z'
  }
  transfer.coveredSourceDeliveryRetirement = {
    phase,
    retirementRecordSha256: 'b'.repeat(64),
    modelSha256: baseline.modelSha256,
    sourceOutputEndSeq: transfer.committedSourceOutputEndSeq,
    receipt: transfer.commitReceipt,
    delivery: {
      ...baseline.boundary.delivery,
      receivedEndSu: 528,
      sentEndSu: 510,
      creditedEndSu: 500
    }
  }
  persistRelayPtyOwnershipTransfer(state, transfer)
  observeRelayPtyOwnershipTransferOutput(state, identity.terminalId, 'destination-only')
  return { store, state, transfer, reopen, options }
}

it.each(['prepared', 'retired'] as const)(
  'reopens %s covered custody without connection authority',
  (phase) => {
    const f = fixture(phase)
    const saved = f.store.loadAll()[0]
    expect(saved.version).toBe(12)
    expect(saved.sourceOutputEndSeq).toBe(2)
    expect(saved.committedSourceOutputEndSeq).toBe(1)
    expect(saved.rawEmissionCheckpoint).toMatchObject({ rawEndSu: 140, journalThroughSeq: 1 })
    const restored = f.reopen()
    const transfer = restored.transfers.get(identity.bridgeId)!
    expect(transfer.coveredSourceDeliveryRetirement).toEqual(
      f.transfer.coveredSourceDeliveryRetirement
    )
    expect(transfer.coveredSourceDeliveryRetirement?.delivery).toMatchObject({
      receivedEndSu: 528,
      sentEndSu: 510,
      creditedEndSu: 500
    })
    expect(transfer.destinationClaimBinding).toBeUndefined()
    expect(transfer.destinationOutputRoute).toBeUndefined()
    expect(transfer.destinationAcknowledgedSeq).toBe(0)
    expect(f.options.setInputFenced).toHaveBeenCalledWith(identity.terminalId, true)
    persistRelayPtyOwnershipTransfer(restored, transfer)
    expect(f.store.loadAll()[0]).toEqual(saved)
  }
)

it('requires the raw anchor even when zero-display output leaves the journal at the baseline', () => {
  const f = fixture('prepared', true)
  const saved: MutableRecord = structuredClone(f.store.loadAll()[0])
  expect(saved.committedSourceOutputEndSeq).toBe(0)
  expect(saved.rawEmissionCheckpoint?.rawEndSu).toBe(140)
  expect(
    f.reopen().transfers.get(identity.bridgeId)?.coveredSourceDeliveryRetirement?.delivery
      .receivedEndSu
  ).toBe(528)
  delete saved.rawCaptureAnchors
  f.store.save(saved)
  expect(f.reopen).toThrow()
})

type MutableRecord = {
  -readonly [
    K in keyof RelayPtyOwnershipTransferDurableRecord
  ]: RelayPtyOwnershipTransferDurableRecord[K]
}
type RecordMutation = (record: MutableRecord) => void
const mutations: [string, RecordMutation][] = [
  [
    'outstanding window',
    (r) => {
      const boundary = {
        ...r.captureBaseline!.boundary,
        delivery: { ...r.captureBaseline!.boundary.delivery, windowSu: 20 }
      }
      r.captureBaseline = { ...r.captureBaseline!, boundary }
      r.issuedCaptureBoundaries = [boundary]
      r.rawCaptureAnchors = r.rawCaptureAnchors!.map((anchor) => ({ ...anchor, boundary }))
      r.coveredSourceDeliveryRetirement = {
        ...r.coveredSourceDeliveryRetirement!,
        delivery: { ...r.coveredSourceDeliveryRetirement!.delivery, windowSu: 20, sentEndSu: 528 }
      }
    }
  ],
  [
    'receipt',
    (r) => {
      r.coveredSourceDeliveryRetirement = {
        ...r.coveredSourceDeliveryRetirement!,
        receipt: { ...r.commitReceipt!, receiptId: 'changed' }
      }
    }
  ],
  [
    'model',
    (r) => {
      r.coveredSourceDeliveryRetirement = {
        ...r.coveredSourceDeliveryRetirement!,
        modelSha256: 'c'.repeat(64)
      }
    }
  ],
  [
    'cutoff',
    (r) => {
      r.coveredSourceDeliveryRetirement = {
        ...r.coveredSourceDeliveryRetirement!,
        sourceOutputEndSeq: 2
      }
    }
  ],
  [
    'missing anchor',
    (r) => {
      delete r.rawCaptureAnchors
    }
  ],
  [
    'missing checkpoint',
    (r) => {
      delete r.rawEmissionCheckpoint
    }
  ],
  [
    'raw origin',
    (r) => {
      r.rawCaptureAnchors = r.rawCaptureAnchors!.map((a) => ({ ...a, rawOriginSu: 111 }))
    }
  ],
  [
    'partial checkpoint',
    (r) => {
      const slice = {
        emissionId: '140:150',
        rawStartSu: 140,
        rawEndSu: 150,
        displayStartSu: 0,
        displayEndSu: 1,
        displayLengthSu: 2
      }
      r.rawEmissionCheckpoint = {
        rawOriginSu: 112,
        rawEndSu: 140,
        journalThroughSeq: 1,
        pending: slice,
        lastObserved: { slice, journalFirstSeq: 2, journalThroughSeq: 2 }
      }
    }
  ],
  ...[
    { deliveryToken: 'replacement' },
    { windowSu: 2048 },
    { ownerGeneration: 99 },
    { providerGeneration: 99 },
    { clientGeneration: 99 },
    { receivedEndSu: 529 },
    { sentEndSu: 529 },
    { sentEndSu: 499 },
    { creditedEndSu: 499 },
    { creditedEndSu: 511 },
    { sentEndSu: 510.5 },
    { generationClosed: true },
    { exitPublished: true }
  ].map((patch): [string, RecordMutation] => [
    JSON.stringify(patch),
    (r) => {
      r.coveredSourceDeliveryRetirement = {
        ...r.coveredSourceDeliveryRetirement!,
        delivery: { ...r.coveredSourceDeliveryRetirement!.delivery, ...patch }
      }
    }
  ]),
  [
    'legacy covered field',
    (r) => {
      r.version = 10
      delete r.retirementJournalVersion
    }
  ],
  [
    'v11 covered field',
    (r) => {
      r.version = 11
    }
  ],
  [
    'nested wrapper',
    (r) => {
      r.retirementJournalVersion = 11 as never
    }
  ],
  [
    'dual retirement',
    (r) => {
      r.sourceDeliveryRetirement = {
        phase: 'prepared',
        retirementRecordSha256: 'b'.repeat(64),
        delivery: r.captureBaseline!.boundary.delivery
      }
    }
  ]
]

it.each(mutations)('refuses tampered durable covered custody: %s', (_label, mutate) => {
  const f = fixture()
  const saved = structuredClone(f.store.loadAll()[0])
  mutate(saved)
  f.store.save(saved)
  expect(f.reopen).toThrow()
})
