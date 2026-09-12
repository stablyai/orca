import { describe, expect, it, vi } from 'vitest'
import type { RelayPtyOwnershipTransferDurableRecord } from './relay-pty-ownership-transfer-adapter-contract'
import { newRelayPtyOwnershipTransferAdapterState } from './relay-pty-ownership-transfer-adapter-state'
import { persistRelayPtyOwnershipTransfer } from './relay-pty-ownership-transfer-adapter-persistence'
import { parseDestinationControls } from './relay-pty-ownership-transfer-journal-record-validation'
import { PTY_OWNERSHIP_TRANSFER_DESTINATION_MAX_DURABLE_INPUT_BYTES } from '../shared/pty-ownership-transfer-destination-input'
import {
  context,
  identity,
  makeDelegatedRelay,
  preparation,
  request,
  source
} from './relay-pty-ownership-transfer-delegation-test-fixture'

function fixture(epoch?: number) {
  let records: RelayPtyOwnershipTransferDurableRecord[] = []
  const store = {
    loadAll: () => structuredClone(records),
    save: (record: RelayPtyOwnershipTransferDurableRecord) => {
      records = [structuredClone(record)]
    },
    remove: vi.fn()
  }
  const adapter = makeDelegatedRelay(store, { enableDestinationOutputRetention: true })
  adapter.prepare(preparation)
  adapter.claimDestination(request(), context())
  const committed: RelayPtyOwnershipTransferDurableRecord = {
    ...records[0],
    version: 8,
    phase: 'committed',
    destinationInputJournal: true,
    ...(epoch === undefined ? {} : { destinationInputEpoch: epoch }),
    destinationInputs: [{ inputId: 'input', data: 'pwd\n', outcome: 'unverifiable' }],
    destinationControlJournal: true,
    destinationControls: [
      {
        controlId: 'resize',
        serializedControl: '{"kind":"resize","cols":80,"rows":24}',
        outcome: 'applied'
      },
      {
        controlId: 'stop',
        serializedControl: '{"kind":"shutdown","immediate":false}',
        outcome: 'unverifiable'
      }
    ],
    commitReceipt: {
      receiptId: 'commit',
      bridgeId: identity.bridgeId,
      acceptedSourceEndSeq: 0,
      committedAt: '2026-09-06T00:00:00.000Z'
    }
  }
  store.save(committed)
  const applyDestinationControl = vi.fn()
  const restore = (inputIds = 16) =>
    newRelayPtyOwnershipTransferAdapterState({
      replayBytes: 1024,
      inputIds,
      options: {
        store,
        resolveSource: () => source,
        authorizeRequest: () => false,
        setInputFenced: vi.fn(),
        writeDestinationInput: vi.fn(),
        publishDestinationOutput: vi.fn(),
        applyDestinationControl
      }
    })
  return { store, committed, restore, applyDestinationControl }
}

describe('delegated control journal v8', () => {
  it.each([undefined, 1, 2, Number.MAX_SAFE_INTEGER])(
    'round trips exact outcomes and epoch %s without authority',
    (epoch) => {
      const { store, committed, restore, applyDestinationControl } = fixture(epoch)
      const state = restore()
      const transfer = state.transfers.get(identity.bridgeId)!
      expect(transfer.destinationInputEpoch).toBe(epoch)
      expect([...transfer.destinationControls!]).toEqual(
        committed.destinationControls!.map(({ controlId, ...control }) => [controlId, control])
      )
      expect(transfer.destinationClaimBinding).toBeUndefined()
      expect(transfer.destinationOutputRoute).toBeUndefined()
      expect(applyDestinationControl).not.toHaveBeenCalled()
      persistRelayPtyOwnershipTransfer(state, transfer)
      expect(store.loadAll()[0]).toEqual(committed)
    }
  )

  it.each([
    { destinationControlJournal: undefined },
    { destinationControlJournal: false },
    { destinationControls: undefined },
    { destinationControls: {} },
    { destinationInputJournal: undefined },
    { destinationInputs: undefined },
    { destinationInputEpoch: 0 },
    { destinationInputEpoch: null },
    { destinationInputEpoch: 1.5 },
    { destinationInputEpoch: Number.MAX_SAFE_INTEGER + 1 },
    { phase: 'prepared' },
    { phase: 'aborted' },
    { phase: 'published' },
    { destinationOutputRetention: undefined },
    { destinationDelegation: undefined },
    { destinationClaim: undefined },
    { commitReceipt: undefined },
    { acceptedInputs: [{ inputId: 'legacy', data: '' }] },
    { acceptedControls: [{ controlId: 'legacy', serializedControl: '{}', outcome: 'applied' }] },
    { reconnectRoute: { generation: 1, attachmentId: 'legacy' } },
    { attachmentBinding: { clientId: 1 } }
  ])('rejects missing evidence %#', (patch) => {
    const { store, committed, restore } = fixture()
    store.save({ ...committed, ...patch } as RelayPtyOwnershipTransferDurableRecord)
    const before = store.loadAll()
    expect(() => restore()).toThrow('journal_invalid')
    expect(store.loadAll()).toEqual(before)
  })

  it.each([
    { controlId: '' },
    { controlId: 'x'.repeat(257) },
    { outcome: 'pending' },
    { serializedControl: '{' },
    { serializedControl: '{}' },
    { serializedControl: 'null' },
    { serializedControl: '{"kind":"resize","cols":0,"rows":24}' },
    { serializedControl: '{"kind":"shutdown","immediate":"false"}' },
    { serializedControl: '{"kind":"sendSignal","signal":""}' }
  ])('rejects invalid control %#', (patch) => {
    const { store, committed, restore } = fixture()
    store.save({
      ...committed,
      destinationControls: [{ ...committed.destinationControls![0], ...patch }]
    } as RelayPtyOwnershipTransferDurableRecord)
    expect(() => restore()).toThrow('journal_invalid')
  })

  it.each([1, 2, 3, 4, 5, 6, 7])('rejects control evidence in version %i', (version) => {
    for (const patch of [{ destinationControlJournal: true }, { destinationControls: [] }]) {
      expect(() => parseDestinationControls({ version, ...patch }, 16)).toThrow('journal_invalid')
    }
  })

  it('rejects duplicates and capacity reductions without trimming', () => {
    const { store, committed, restore } = fixture()
    expect(() => restore(1)).toThrow('journal_invalid')
    store.save({
      ...committed,
      destinationControls: [committed.destinationControls![0], committed.destinationControls![0]]
    })
    expect(() => restore()).toThrow('journal_invalid')
  })

  it('bounds total UTF-8 bytes including control IDs', () => {
    const serializedControl = JSON.stringify({
      kind: 'sendSignal',
      signal: 'é'.repeat(PTY_OWNERSHIP_TRANSFER_DESTINATION_MAX_DURABLE_INPUT_BYTES / 2)
    })
    expect(() =>
      parseDestinationControls(
        {
          version: 8,
          destinationControlJournal: true,
          destinationControls: [{ controlId: 'signal', serializedControl, outcome: 'applied' }]
        },
        16
      )
    ).toThrow('journal_invalid')
  })

  it('preserves empty mutation maps and never downgrades v8 after retirement', () => {
    const { store, restore } = fixture(2)
    const state = restore()
    const transfer = state.transfers.get(identity.bridgeId)!
    transfer.destinationControls!.clear()
    transfer.destinationInputs!.clear()
    persistRelayPtyOwnershipTransfer(state, transfer)
    expect(store.loadAll()[0]).toMatchObject({
      version: 8,
      destinationInputEpoch: 2,
      destinationControls: [],
      destinationInputs: []
    })
    expect(restore().transfers.get(identity.bridgeId)?.destinationControlJournal).toBe(true)
  })
})
