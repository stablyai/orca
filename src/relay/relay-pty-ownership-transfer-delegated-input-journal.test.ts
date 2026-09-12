import { describe, expect, it, vi } from 'vitest'
import type { RelayPtyOwnershipTransferDurableRecord } from './relay-pty-ownership-transfer-adapter-contract'
import { newRelayPtyOwnershipTransferAdapterState } from './relay-pty-ownership-transfer-adapter-state'
import { persistRelayPtyOwnershipTransfer } from './relay-pty-ownership-transfer-adapter-persistence'
import { parseDestinationInputs } from './relay-pty-ownership-transfer-journal-record-validation'
import { PTY_OWNERSHIP_TRANSFER_DESTINATION_MAX_DURABLE_INPUT_BYTES } from '../shared/pty-ownership-transfer-destination-input'
import {
  context,
  identity,
  makeDelegatedRelay,
  preparation,
  request,
  source
} from './relay-pty-ownership-transfer-delegation-test-fixture'

function fixture() {
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
    version: 6,
    phase: 'committed',
    destinationInputJournal: true,
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

describe('delegated input journal v6', () => {
  it('round trips outcomes without replaying an uncertain or applied write', () => {
    const { store, committed, restore, writeDestinationInput } = fixture()
    const state = restore()
    const transfer = state.transfers.get(identity.bridgeId)!
    expect(transfer.destinationInputJournal).toBe(true)
    expect([...transfer.destinationInputs!]).toEqual([
      ['applied', { data: 'pwd\n', outcome: 'applied' }],
      ['uncertain', { data: 'command\n', outcome: 'unverifiable' }]
    ])
    expect(transfer.destinationClaimBinding).toBeUndefined()
    expect(writeDestinationInput).not.toHaveBeenCalled()
    persistRelayPtyOwnershipTransfer(state, transfer)
    expect(store.loadAll()[0]).toEqual(committed)
  })

  it('selects v6 when the first input is admitted to a committed v5 record', () => {
    const { store, committed, restore } = fixture()
    const { destinationInputJournal: _marker, destinationInputs: _inputs, ...v5 } = committed
    store.save({ ...v5, version: 5 })
    const state = restore()
    const transfer = state.transfers.get(identity.bridgeId)!
    expect(transfer.destinationInputs).toBeUndefined()
    transfer.destinationInputJournal = true
    transfer.destinationInputs = new Map([['first', { data: '', outcome: 'unverifiable' }]])
    persistRelayPtyOwnershipTransfer(state, transfer)
    expect(store.loadAll()[0]).toMatchObject({
      version: 6,
      destinationInputJournal: true,
      destinationInputs: [{ inputId: 'first', data: '', outcome: 'unverifiable' }]
    })
    expect(() => restore()).not.toThrow()
  })

  it.each([
    { destinationInputJournal: undefined },
    { destinationInputJournal: false },
    { destinationInputs: undefined },
    { destinationInputs: {} },
    { destinationInputs: [{ inputId: '', data: '', outcome: 'applied' }] },
    { destinationInputs: [{ inputId: 'x'.repeat(257), data: '', outcome: 'applied' }] },
    { destinationInputs: [{ inputId: 'x', data: 1, outcome: 'applied' }] },
    { destinationInputs: [{ inputId: 'x', data: '', outcome: 'pending' }] },
    { destinationInputs: [{ inputId: 'x', data: '' }] },
    { destinationInputs: [null] },
    {
      destinationInputs: [
        { inputId: 'x', data: '', outcome: 'applied' },
        { inputId: 'x', data: '', outcome: 'unverifiable' }
      ]
    },
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
  ])('rejects invalid or conflicting input journal evidence %#', (patch) => {
    const { store, committed, restore } = fixture()
    store.save({ ...committed, ...patch } as RelayPtyOwnershipTransferDurableRecord)
    const before = store.loadAll()
    expect(() => restore()).toThrow('journal_invalid')
    expect(store.loadAll()).toEqual(before)
  })

  it.each([1, 2, 3, 4, 5] as const)('rejects input fields in version %i', (version) => {
    const { store, committed, restore } = fixture()
    store.save({ ...committed, version })
    expect(() => restore()).toThrow('journal_invalid')
    expect(parseDestinationInputs({ version }, 16)).toBeUndefined()
    for (const fields of [
      { destinationInputs: [] },
      { destinationInputJournal: true },
      { destinationInputJournal: false }
    ]) {
      expect(() => parseDestinationInputs({ version, ...fields }, 16)).toThrow('journal_invalid')
    }
  })

  it('enforces the configured count without dropping old receipts', () => {
    const { store, committed, restore } = fixture()
    expect(() => restore(1)).toThrow('journal_invalid')
    expect(store.loadAll()[0]).toEqual(committed)
  })

  it('bounds cumulative UTF-8 bytes including IDs', () => {
    const { store, committed, restore } = fixture()
    const data = 'é'.repeat(PTY_OWNERSHIP_TRANSFER_DESTINATION_MAX_DURABLE_INPUT_BYTES / 2 - 1)
    store.save({
      ...committed,
      destinationInputs: [{ inputId: 'é', data, outcome: 'unverifiable' }]
    })
    expect(() => restore()).not.toThrow()
    store.save({
      ...committed,
      destinationInputs: [
        { inputId: 'é', data, outcome: 'unverifiable' },
        { inputId: 'x', data: '', outcome: 'applied' }
      ]
    })
    expect(() => restore()).toThrow('journal_invalid')
  })
})
