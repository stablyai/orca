import { describe, expect, it, vi } from 'vitest'
import type { RelayPtyOwnershipTransferDurableRecord } from './relay-pty-ownership-transfer-adapter-contract'
import { newRelayPtyOwnershipTransferAdapterState } from './relay-pty-ownership-transfer-adapter-state'
import { persistRelayPtyOwnershipTransfer } from './relay-pty-ownership-transfer-adapter-persistence'
import { parseDestinationInputs } from './relay-pty-ownership-transfer-journal-record-validation'
import {
  context,
  identity,
  makeDelegatedRelay,
  preparation,
  request,
  source
} from './relay-pty-ownership-transfer-delegation-test-fixture'

function fixture(epoch = 1) {
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
    version: 7,
    phase: 'committed',
    destinationInputJournal: true,
    destinationInputEpoch: epoch,
    destinationInputs: [
      { inputId: 'applied', data: 'pwd\n', outcome: 'applied' },
      { inputId: 'uncertain', data: 'command\n', outcome: 'unverifiable' }
    ],
    commitReceipt: {
      receiptId: 'commit',
      bridgeId: identity.bridgeId,
      acceptedSourceEndSeq: 0,
      committedAt: '2026-09-06T00:00:00.000Z'
    }
  }
  store.save(committed)
  const writeDestinationInput = vi.fn()
  const restore = (inputIds = 16) =>
    newRelayPtyOwnershipTransferAdapterState({
      replayBytes: 1024,
      inputIds,
      options: {
        store,
        resolveSource: () => source,
        authorizeRequest: () => false,
        setInputFenced: vi.fn(),
        writeDestinationInput,
        publishDestinationOutput: vi.fn()
      }
    })
  return { store, committed, restore, writeDestinationInput }
}

describe('delegated input retirement journal v7', () => {
  it.each([1, 2, Number.MAX_SAFE_INTEGER])(
    'round trips epoch %i and exact input outcomes',
    (epoch) => {
      const { store, committed, restore, writeDestinationInput } = fixture(epoch)
      const state = restore()
      const transfer = state.transfers.get(identity.bridgeId)!
      expect(transfer.destinationInputEpoch).toBe(epoch)
      expect([...transfer.destinationInputs!]).toEqual([
        ['applied', { data: 'pwd\n', outcome: 'applied' }],
        ['uncertain', { data: 'command\n', outcome: 'unverifiable' }]
      ])
      expect(transfer.destinationClaimBinding).toBeUndefined()
      expect(writeDestinationInput).not.toHaveBeenCalled()
      persistRelayPtyOwnershipTransfer(state, transfer)
      expect(store.loadAll()[0]).toEqual(committed)
    }
  )

  it('selects v7 after retiring the v6 input map and preserves an empty map', () => {
    const { store, committed, restore } = fixture()
    const { destinationInputEpoch: _epoch, ...v6 } = committed
    store.save({ ...v6, version: 6 })
    const state = restore()
    const transfer = state.transfers.get(identity.bridgeId)!
    expect(transfer.destinationInputEpoch).toBeUndefined()
    transfer.destinationInputEpoch = 1
    transfer.destinationInputs!.clear()
    persistRelayPtyOwnershipTransfer(state, transfer)
    expect(store.loadAll()[0]).toEqual({ ...committed, destinationInputs: [] })
    expect(restore().transfers.get(identity.bridgeId)?.destinationInputs?.size).toBe(0)
  })

  it.each([
    { destinationInputEpoch: undefined },
    { destinationInputEpoch: 0 },
    { destinationInputEpoch: -1 },
    { destinationInputEpoch: 1.5 },
    { destinationInputEpoch: '1' },
    { destinationInputEpoch: null },
    { destinationInputEpoch: Number.MAX_SAFE_INTEGER + 1 },
    { destinationInputEpoch: Infinity },
    { destinationInputEpoch: Number.NaN },
    { destinationInputJournal: undefined },
    { destinationInputJournal: false },
    { destinationInputs: undefined },
    { destinationInputs: {} },
    { destinationInputs: [{ inputId: 'x', data: '', outcome: 'pending' }] },
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
  ])('rejects invalid epoch or missing committed input evidence %#', (patch) => {
    const { store, committed, restore } = fixture()
    store.save({ ...committed, ...patch } as RelayPtyOwnershipTransferDurableRecord)
    const before = store.loadAll()
    expect(() => restore()).toThrow('journal_invalid')
    expect(store.loadAll()).toEqual(before)
  })

  it.each([1, 2, 3, 4, 5, 6] as const)(
    'rejects downgrade to version %i with an epoch',
    (version) => {
      const { store, committed, restore } = fixture()
      store.save({ ...committed, version })
      expect(() => restore()).toThrow('journal_invalid')
      expect(() => parseDestinationInputs({ version, destinationInputEpoch: 1 }, 16)).toThrow(
        'journal_invalid'
      )
    }
  )

  it('preserves the bounded map instead of trimming input evidence on restore', () => {
    const { store, committed, restore } = fixture()
    expect(() => restore(1)).toThrow('journal_invalid')
    expect(store.loadAll()[0]).toEqual(committed)
  })
})
