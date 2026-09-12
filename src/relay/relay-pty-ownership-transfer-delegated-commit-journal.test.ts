import { describe, expect, it, vi } from 'vitest'
import type { RelayPtyOwnershipTransferDurableRecord } from './relay-pty-ownership-transfer-adapter-contract'
import { newRelayPtyOwnershipTransferAdapterState } from './relay-pty-ownership-transfer-adapter-state'
import { persistRelayPtyOwnershipTransfer } from './relay-pty-ownership-transfer-adapter-persistence'
import {
  context,
  identity,
  makeDelegatedRelay,
  preparation,
  request,
  source
} from './relay-pty-ownership-transfer-delegation-test-fixture'

const receipt = {
  receiptId: 'host-commit-1',
  bridgeId: identity.bridgeId,
  acceptedSourceEndSeq: 1,
  committedAt: '2026-09-06T00:00:00.000Z'
}

function fixture() {
  let records: RelayPtyOwnershipTransferDurableRecord[] = []
  const store = {
    loadAll: () => structuredClone(records),
    save: (record: RelayPtyOwnershipTransferDurableRecord) => {
      records = [structuredClone(record)]
    },
    remove: vi.fn()
  }
  const adapter = makeDelegatedRelay(store, {
    enableDestinationOutputRetention: true,
    replayBytes: 6
  })
  adapter.prepare(preparation)
  adapter.claimDestination(request(), context())
  adapter.observeOutput(identity.terminalId, 'one')
  const prepared = store.loadAll()[0]
  const committed: RelayPtyOwnershipTransferDurableRecord = {
    ...prepared,
    version: 5,
    phase: 'committed',
    commitReceipt: receipt
  }
  const setInputFenced = vi.fn()
  const restore = (replayBytes = 6) =>
    newRelayPtyOwnershipTransferAdapterState({
      replayBytes,
      inputIds: 16,
      options: {
        store,
        resolveSource: () => source,
        authorizeRequest: () => false,
        setInputFenced,
        writeDestinationInput: () => {},
        publishDestinationOutput: () => {}
      }
    })
  return { store, prepared, committed, restore, setInputFenced }
}

describe('delegated committed retention journals', () => {
  it('restores committed authority without restoring any connection or delivery proof', () => {
    const { store, committed, restore, setInputFenced } = fixture()
    store.save(committed)
    const state = restore()
    const transfer = state.transfers.get(identity.bridgeId)!
    expect(transfer).toMatchObject({
      phase: 'committed',
      identity,
      destinationClaim: committed.destinationClaim,
      destinationOutputRetention: true,
      destinationAcknowledgedSeq: 0,
      commitReceipt: receipt
    })
    for (const key of [
      'destinationClaimBinding',
      'destinationDeliveredSeq',
      'destinationOutputRoute',
      'attachmentId',
      'attachmentBinding',
      'reconnectRoute'
    ]) {
      expect(transfer).not.toHaveProperty(key)
    }
    expect(setInputFenced).toHaveBeenCalledWith(identity.terminalId, true)
    persistRelayPtyOwnershipTransfer(state, transfer)
    expect(store.loadAll()[0]).toEqual(committed)
  })

  it('retains the exact commit receipt after later output and exit, including trimmed ACKed output', () => {
    const { store, committed, restore } = fixture()
    const later = {
      ...committed,
      sourceOutputEndSeq: 2,
      replayStartSeq: 2,
      history: { nextSeq: 3, frames: [{ seq: 2, data: 'two' }] },
      exit: {
        verdict: 'exited' as const,
        eventId: 'exit-1',
        observedAt: '2026-09-06T00:00:01.000Z',
        code: 0
      }
    }
    store.save(later)
    const state = restore()
    const transfer = state.transfers.get(identity.bridgeId)!
    expect(transfer.destinationAcknowledgedSeq).toBe(1)
    expect(transfer.commitReceipt).toEqual(receipt)
    persistRelayPtyOwnershipTransfer(state, transfer)
    expect(store.loadAll()[0]).toEqual(later)
  })

  it('selects v5 on the first committed save instead of writing a contradictory v4', () => {
    const { store, restore } = fixture()
    const state = restore()
    const transfer = state.transfers.get(identity.bridgeId)!
    transfer.phase = 'committed'
    transfer.commitReceipt = receipt
    persistRelayPtyOwnershipTransfer(state, transfer)
    expect(store.loadAll()[0]).toMatchObject({
      version: 5,
      phase: 'committed',
      commitReceipt: receipt
    })
    expect(() => restore()).not.toThrow()
  })

  it.each([
    { version: 4 },
    { version: 3 },
    { phase: 'prepared' },
    { phase: 'aborted' },
    { phase: 'published' },
    { destinationOutputRetention: undefined },
    { destinationOutputRetention: false },
    { destinationDelegation: undefined },
    { destinationClaim: undefined },
    { destinationClaim: { generation: 0, claimId: 'invalid' } },
    { commitReceipt: undefined },
    { commitReceipt: { ...receipt, bridgeId: 'another-bridge' } },
    { commitReceipt: { ...receipt, acceptedSourceEndSeq: 2 } },
    { commitReceipt: { ...receipt, committedAt: 'not-a-time' } },
    { surfacePublication: undefined },
    {
      surfacePublication: {
        ...preparation.surfacePublication,
        surfaceBinding: {
          ...preparation.surfacePublication.surfaceBinding,
          executionHostId: 'ssh:another-host'
        }
      }
    },
    { attachmentId: 'legacy' },
    { attachmentBinding: { clientId: 1, transportGeneration: 0 } },
    { reconnectRoute: { generation: 8, attachmentId: 'legacy' } },
    { acceptedInputs: [{ inputId: 'legacy', data: 'command' }] },
    { acceptedControls: [{ controlId: 'legacy', serializedControl: '{}', outcome: 'applied' }] },
    { observedEmissions: [{ key: 'legacy', data: 'one', frames: [{ seq: 1, data: 'one' }] }] }
  ])('rejects contradictory v5 evidence without mutating the journal %#', (patch) => {
    const { store, committed, restore } = fixture()
    store.save({ ...committed, ...patch } as RelayPtyOwnershipTransferDurableRecord)
    const before = store.loadAll()
    expect(() => restore()).toThrow('journal_invalid')
    expect(store.loadAll()).toEqual(before)
  })

  it('does not trim protected committed output to fit a smaller restart budget', () => {
    const { store, committed, restore } = fixture()
    store.save(committed)
    expect(() => restore(2)).toThrow('journal_invalid')
    expect(store.loadAll()[0]).toEqual(committed)
  })

  it.each(['prepared', 'aborted'] as const)('keeps v4 %s records readable', (phase) => {
    const { store, prepared, restore } = fixture()
    store.save({ ...prepared, phase })
    expect(restore().transfers.get(identity.bridgeId)?.phase).toBe(phase)
  })
})
