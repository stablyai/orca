import { expect, it, vi } from 'vitest'
import {
  identity,
  preparation,
  source,
  makeDelegatedRelay
} from './relay-pty-ownership-transfer-delegation-test-fixture'
import { parsePtyOwnershipCaptureBaseline } from '../shared/pty-ownership-capture-baseline'
import { newRelayPtyOwnershipTransferAdapterState } from './relay-pty-ownership-transfer-adapter-state'
import { persistRelayPtyOwnershipTransfer } from './relay-pty-ownership-transfer-adapter-persistence'
import { retainRelayPtyCommittedSourceCustody } from './relay-pty-committed-source-custody'
import { retireRelayPtyCoveredSourceDelivery } from './relay-pty-covered-source-retirement-execution'
import type { RelayPtyOwnershipTransferDurableRecord } from './relay-pty-ownership-transfer-adapter-contract'

function setup() {
  let saved: RelayPtyOwnershipTransferDurableRecord | undefined
  let failure: { phase: 'prepared' | 'retired'; when: 'before' | 'after' } | undefined
  const store = {
    loadAll: () => (saved ? [structuredClone(saved)] : []),
    remove: vi.fn(),
    save: vi.fn((record: RelayPtyOwnershipTransferDurableRecord) => {
      const fail = failure?.phase === record.coveredSourceDeliveryRetirement?.phase && !!failure
      if (!fail || failure?.when !== 'before') {
        saved = structuredClone(record)
      }
      if (fail) {
        throw new Error('write uncertain')
      }
    })
  }
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
  relay.observeOutput(identity.terminalId, 'one🙂', '112:140', undefined, {
    emissionId: '112:140',
    rawStartSu: 112,
    rawEndSu: 140,
    displayStartSu: 0,
    displayEndSu: 5,
    displayLengthSu: 5
  })
  const state = newRelayPtyOwnershipTransferAdapterState({ options })
  const transfer = state.transfers.get(identity.bridgeId)!
  // Modeled commit; the custody validator and persistence transaction are real.
  transfer.phase = 'committed'
  transfer.destinationClaim = { generation: 1, claimId: 'claim' }
  transfer.committedSourceOutputEndSeq = transfer.sourceOutputEndSeq
  transfer.commitReceipt = {
    bridgeId: identity.bridgeId,
    receiptId: 'receipt',
    acceptedSourceEndSeq: 0,
    committedAt: '2026-09-08T00:00:00.000Z'
  }
  persistRelayPtyOwnershipTransfer(state, transfer)
  const custody = retainRelayPtyCommittedSourceCustody(state, identity, baseline, {
    ...baseline.boundary.delivery,
    receivedEndSu: 528,
    sentEndSu: 510,
    creditedEndSu: 500
  })
  let removed = false
  const cleanup = {
    delivery: custody.delivery,
    assertCurrent: vi.fn(),
    assertRemoved: vi.fn(() => {
      if (!removed) {
        throw new Error('closed evidence missing')
      }
    }),
    remove: vi.fn((assertAuthority: () => void) => {
      assertAuthority()
      expect(store.loadAll()[0].coveredSourceDeliveryRetirement?.phase).toBe('prepared')
      removed = true
    })
  }
  const prepare = vi.fn(() => cleanup)
  store.save.mockClear()
  return {
    state,
    options,
    baseline,
    transfer,
    store,
    custody,
    cleanup,
    prepare,
    run: (recoveryOnly = false, hash = 'b'.repeat(64)) =>
      retireRelayPtyCoveredSourceDelivery(state, custody, hash, recoveryOnly, prepare),
    fail: (next: typeof failure) => {
      failure = next
    }
  }
}

it('writes intent before removal and completion before proof, retaining actual unacked counters', () => {
  const f = setup()
  expect(f.run().sourceCancellation).toEqual({ canceled: true, sentEndSu: 510, creditedEndSu: 500 })
  expect(f.store.save.mock.calls.map(([r]) => r.coveredSourceDeliveryRetirement?.phase)).toEqual([
    'prepared',
    'retired'
  ])
  expect(f.store.loadAll()[0].coveredSourceDeliveryRetirement?.delivery.receivedEndSu).toBe(528)
  f.run(true)
  expect(f.cleanup.remove).toHaveBeenCalledOnce()
  expect(f.cleanup.assertRemoved).toHaveBeenCalled()
})

it('refuses recovery without durable intent before preparing cleanup', () => {
  const f = setup()
  expect(() => f.run(true)).toThrow('recovery_journal_required')
  expect(f.prepare).not.toHaveBeenCalled()
  expect(f.store.save).not.toHaveBeenCalled()
})

it('refuses ordinary retirement evidence before preparing covered cleanup', () => {
  const f = setup()
  f.transfer.sourceDeliveryRetirement = {
    phase: 'prepared',
    retirementRecordSha256: 'b'.repeat(64),
    delivery: f.custody.delivery
  }
  expect(() => f.run()).toThrow('covered_custody_required')
  expect(f.prepare).not.toHaveBeenCalled()
  expect(f.store.save).not.toHaveBeenCalled()
})

it('refuses changed retry hash without writes or cleanup preparation', () => {
  const f = setup()
  f.run()
  f.prepare.mockClear()
  f.store.save.mockClear()
  expect(() => f.run(true, 'c'.repeat(64))).toThrow('attempt_changed')
  expect(f.prepare).not.toHaveBeenCalled()
  expect(f.store.save).not.toHaveBeenCalled()
})

it.each([{ sentEndSu: 511 }, { creditedEndSu: 501 }, { deliveryToken: 'replacement' }])(
  'refuses changed cleanup delivery %j before persistence',
  (patch) => {
    const f = setup()
    f.cleanup.delivery = { ...f.custody.delivery, ...patch }
    expect(() => f.run()).toThrow()
    expect(f.store.save).not.toHaveBeenCalled()
    expect(f.cleanup.remove).not.toHaveBeenCalled()
  }
)

it.each([
  ['prepared', 'before'],
  ['prepared', 'after'],
  ['retired', 'before'],
  ['retired', 'after']
] as const)('withholds proof on %s write failure %s save', (phase, when) => {
  const f = setup()
  f.fail({ phase, when })
  expect(() => f.run()).toThrow('write uncertain')
  expect(f.cleanup.remove).toHaveBeenCalledTimes(phase === 'prepared' ? 0 : 1)
  expect(f.transfer.destinationDelegationWriteUnverifiable).toBe(true)
  expect(f.transfer.destinationClaimBinding).toBeUndefined()
  const calls = f.store.save.mock.calls.length
  expect(() => f.run()).toThrow()
  expect(f.store.save).toHaveBeenCalledTimes(calls)
})

it.each([false, true])('retries exact intent after cancellation throw (closed=%s)', (closed) => {
  const f = setup()
  const remove = f.cleanup.remove.getMockImplementation()!
  f.cleanup.remove.mockImplementationOnce((assertAuthority) => {
    if (closed) {
      remove(assertAuthority)
    }
    throw new Error('cancel interrupted')
  })
  expect(() => f.run()).toThrow('cancel interrupted')
  expect(f.store.loadAll()[0].coveredSourceDeliveryRetirement?.phase).toBe('prepared')
  expect(f.run(true).coveredSourceDeliveryRetirement.phase).toBe('retired')
})

it('requires closed evidence and never treats a no-op removal as success', () => {
  const f = setup()
  f.cleanup.remove.mockImplementation(() => undefined)
  expect(() => f.run()).toThrow('closed evidence missing')
  expect(f.store.loadAll()[0].coveredSourceDeliveryRetirement?.phase).toBe('prepared')
})

it('requires an explicit removal assertion before any write', () => {
  const f = setup()
  Reflect.deleteProperty(f.cleanup, 'assertRemoved')
  expect(() => f.run()).toThrow()
  expect(f.store.save).not.toHaveBeenCalled()
  expect(f.cleanup.remove).not.toHaveBeenCalled()
})

it('refuses custody from a different reopened adapter before cleanup or writes', () => {
  const f = setup()
  const other = newRelayPtyOwnershipTransferAdapterState({ options: f.options })
  f.store.save.mockClear()
  expect(() =>
    retireRelayPtyCoveredSourceDelivery(other, f.custody, 'b'.repeat(64), false, f.prepare)
  ).toThrow()
  expect(f.prepare).not.toHaveBeenCalled()
  expect(f.store.save).not.toHaveBeenCalled()
})

it.each(['prepared', 'retired'] as const)(
  'reconstructs %s journal with fresh custody and checked removal after adapter restart',
  (phase) => {
    const f = setup()
    if (phase === 'prepared') {
      f.cleanup.remove.mockImplementationOnce(() => {
        throw new Error('cancel interrupted')
      })
      expect(() => f.run()).toThrow('cancel interrupted')
    } else {
      f.run()
    }
    const reopened = newRelayPtyOwnershipTransferAdapterState({ options: f.options })
    const custody = retainRelayPtyCommittedSourceCustody(
      reopened,
      identity,
      f.baseline,
      f.custody.delivery
    )
    f.cleanup.remove.mockClear()
    const result = retireRelayPtyCoveredSourceDelivery(
      reopened,
      custody,
      'b'.repeat(64),
      true,
      f.prepare
    )
    expect(result.coveredSourceDeliveryRetirement.phase).toBe('retired')
    expect(f.cleanup.remove).toHaveBeenCalledTimes(phase === 'prepared' ? 1 : 0)
    expect(f.store.loadAll()[0].coveredSourceDeliveryRetirement?.phase).toBe('retired')
  }
)

it('rejects reentrancy while preserving the outer transaction', () => {
  const f = setup()
  f.cleanup.assertCurrent.mockImplementationOnce(() => {
    expect(() => f.run()).toThrow('busy')
  })
  expect(f.run().coveredSourceDeliveryRetirement.phase).toBe('retired')
  expect(f.cleanup.remove).toHaveBeenCalledOnce()
})

it('revalidates custody after cleanup and leaves intent on custody loss', () => {
  const f = setup()
  const remove = f.cleanup.remove.getMockImplementation()!
  f.cleanup.remove.mockImplementationOnce((assertAuthority) => {
    remove(assertAuthority)
    f.transfer.destinationClaim = undefined
  })
  expect(() => f.run()).toThrow('custody_unavailable')
  expect(f.store.loadAll()[0].coveredSourceDeliveryRetirement?.phase).toBe('prepared')
})
