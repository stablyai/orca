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
import { retainRelayPtyCommittedSourceCustody } from './relay-pty-committed-source-custody'
import { observeRelayPtyOwnershipTransferOutput } from './relay-pty-ownership-transfer-output-observation'

const directories: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})
const baseline = parsePtyOwnershipCaptureBaseline(
  {
    version: 1,
    modelSha256: 'a'.repeat(64),
    boundary: {
      version: 1,
      identity,
      throughSeq: 1,
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
function setup(initialOutput = true) {
  const directory = mkdtempSync(join(tmpdir(), 'orca-raw-anchor-'))
  directories.push(directory)
  const store = new RelayPtyOwnershipTransferFileStore(directory)
  const options = {
    enableDestinationOutputRetention: true,
    resolveTerminalIncarnation: () => identity.incarnationId,
    hasPendingSourceOutput: () => false
  }
  const relay = makeDelegatedRelay(store, options)
  relay.prepare(preparation)
  if (initialOutput) {
    relay.observeOutput(identity.terminalId, 'before', '100:112', undefined, {
      emissionId: '100:112',
      rawStartSu: 100,
      rawEndSu: 112,
      displayStartSu: 0,
      displayEndSu: 6,
      displayLengthSu: 6
    })
  }
  const selected = initialOutput
    ? baseline
    : parsePtyOwnershipCaptureBaseline(
        { ...baseline, boundary: { ...baseline.boundary, throughSeq: 0 } },
        identity
      )
  relay.retainCaptureBoundary(identity, selected.boundary, initialOutput ? undefined : 112)
  relay.selectCaptureBaseline(identity, selected, () => selected.boundary)
  return { relay, store, selected, options, reopen: () => makeDelegatedRelay(store, options) }
}

it('retains committed custody of actual unacknowledged counters while destination output advances', () => {
  const f = setup()
  f.relay.observeOutput(identity.terminalId, 'one🙂', '112:134', undefined, {
    emissionId: '112:134',
    rawStartSu: 112,
    rawEndSu: 134,
    displayStartSu: 0,
    displayEndSu: 5,
    displayLengthSu: 5
  })
  const state = newRelayPtyOwnershipTransferAdapterState({
    options: {
      ...f.options,
      store: f.store,
      resolveSource: () => source,
      authorizeRequest: () => false,
      setInputFenced: () => {},
      writeDestinationInput: () => {},
      publishDestinationOutput: () => {}
    }
  })
  const transfer = state.transfers.get(identity.bridgeId)!
  const actual = {
    ...baseline.boundary.delivery,
    receivedEndSu: 522,
    sentEndSu: 510,
    creditedEndSu: 500
  }
  expect(() => retainRelayPtyCommittedSourceCustody(state, identity, baseline, actual)).toThrow(
    'custody_unavailable'
  )
  transfer.phase = 'committed'
  transfer.destinationClaim = { generation: 1, claimId: 'claim-1' }
  transfer.committedSourceOutputEndSeq = 2
  transfer.commitReceipt = {
    bridgeId: identity.bridgeId,
    receiptId: 'committed',
    acceptedSourceEndSeq: 1,
    committedAt: '2026-09-08T00:00:00.000Z'
  }
  const custody = retainRelayPtyCommittedSourceCustody(state, identity, baseline, actual)
  for (const patch of [
    { receivedEndSu: 523 },
    { sentEndSu: 523 },
    { creditedEndSu: 499 },
    { deliveryToken: 'replacement' }
  ]) {
    expect(() =>
      retainRelayPtyCommittedSourceCustody(state, identity, baseline, { ...actual, ...patch })
    ).toThrow('custody_unavailable')
  }
  observeRelayPtyOwnershipTransferOutput(state, identity.terminalId, 'destination-only')
  expect(transfer.sourceOutputEndSeq).toBe(3)
  expect(custody.sourceOutputEndSeq).toBe(2)
  expect(custody.delivery).toEqual(actual)
  expect(custody.assertCurrent).not.toThrow()
  const restored = newRelayPtyOwnershipTransferAdapterState({ options: state.options })
  expect(
    retainRelayPtyCommittedSourceCustody(restored, identity, baseline, actual).delivery
  ).toEqual(actual)
  transfer.commitReceipt = { ...transfer.commitReceipt, receiptId: 'replacement' }
  expect(custody.assertCurrent).toThrow('custody_unavailable')
})

it('anchors an output-free capture at the host cursor and recovers the first later emission', () => {
  const f = setup(false)
  expect(f.store.loadAll()[0].rawEmissionCheckpoint).toBeUndefined()
  expect(f.reopen().inspectSuccessorCaptureEvidence(identity, f.selected)).toMatchObject({
    throughSeq: 0,
    delivery: { receivedEndSu: 500 }
  })
  f.relay.observeOutput(identity.terminalId, 'one🙂', '112:134', undefined, {
    emissionId: '112:134',
    rawStartSu: 112,
    rawEndSu: 134,
    displayStartSu: 0,
    displayEndSu: 5,
    displayLengthSu: 5
  })
  expect(f.reopen().inspectSuccessorCaptureEvidence(identity, f.selected)).toMatchObject({
    throughSeq: 1,
    delivery: { receivedEndSu: 522 }
  })
})

it.each(['text', 'empty'])(
  'recovers %s raw progress using capture-time origin, including reopen',
  (mode) => {
    const f = setup()
    const data = mode === 'text' ? 'one🙂' : ''
    f.relay.observeOutput(identity.terminalId, data, '112:134', undefined, {
      emissionId: '112:134',
      rawStartSu: 112,
      rawEndSu: 134,
      displayStartSu: 0,
      displayEndSu: data.length,
      displayLengthSu: data.length
    })
    expect(f.store.loadAll()[0].rawCaptureAnchors).toEqual([
      { boundary: baseline.boundary, rawOriginSu: 100, rawEndSu: 112 }
    ])
    const expected = {
      throughSeq: mode === 'text' ? 2 : 1,
      delivery: { receivedEndSu: 522, sentEndSu: 522, creditedEndSu: 522 }
    }
    expect(f.relay.inspectSuccessorCaptureEvidence(identity, baseline)).toMatchObject(expected)
    expect(f.reopen().inspectSuccessorCaptureEvidence(identity, baseline)).toMatchObject(expected)
    expect(f.store.loadAll()[0].captureBaseline).toEqual(baseline)
  }
)

it('refuses incomplete emission mapping until all slices are durably observed', () => {
  const f = setup()
  const span = {
    emissionId: '112:134',
    rawStartSu: 112,
    rawEndSu: 134,
    displayStartSu: 0,
    displayEndSu: 3,
    displayLengthSu: 5
  }
  f.relay.observeOutput(identity.terminalId, 'one', 'first', undefined, span)
  expect(f.relay.inspectSuccessorCaptureEvidence(identity, baseline)).toBeNull()
  const reopened = f.reopen()
  reopened.observeOutput(identity.terminalId, '🙂', 'last', undefined, {
    ...span,
    displayStartSu: 3,
    displayEndSu: 5
  })
  expect(reopened.inspectSuccessorCaptureEvidence(identity, baseline)).toMatchObject({
    throughSeq: 3,
    delivery: { receivedEndSu: 522 }
  })
})

it('does not reuse an old anchor after untyped output starts a new mapping origin', () => {
  const f = setup()
  f.relay.observeOutput(identity.terminalId, 'untyped')
  f.relay.observeOutput(identity.terminalId, 'new', '200:203', undefined, {
    emissionId: '200:203',
    rawStartSu: 200,
    rawEndSu: 203,
    displayStartSu: 0,
    displayEndSu: 3,
    displayLengthSu: 3
  })
  expect(f.relay.inspectSuccessorCaptureEvidence(identity, baseline)).toBeNull()
  expect(f.reopen().inspectSuccessorCaptureEvidence(identity, baseline)).toBeNull()
})
