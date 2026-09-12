import { expect, it, vi } from 'vitest'
import {
  context,
  identity,
  preparation,
  request,
  source
} from './relay-pty-ownership-transfer-delegation-test-fixture'
import { newRelayPtyOwnershipTransferAdapterState } from './relay-pty-ownership-transfer-adapter-state'
import type { RelayPtyOwnershipTransferDurableRecord } from './relay-pty-ownership-transfer-adapter-contract'
import {
  claimRelayPtyOwnershipTransferDestination,
  recoverRelayPtyOwnershipTransferDestination
} from './relay-pty-ownership-transfer-destination-claim'
import { retireRelayPtySourceDelivery } from './relay-pty-source-retirement-execution'
import { createOrcadLiveSourceRetirementDelivery } from '../main/ssh/orcad-live-source-retirement-delivery'

function setup() {
  let saved: RelayPtyOwnershipTransferDurableRecord = {
    version: 5,
    identity,
    phase: 'committed',
    destinationDelegation: preparation.destinationDelegation,
    surfacePublication: preparation.surfacePublication,
    destinationOutputRetention: true,
    destinationClaim: { generation: 1, claimId: 'claim-1' },
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
    }
  }
  let failure: { phase: 'prepared' | 'retired'; when: 'before' | 'after' } | undefined
  const store = {
    loadAll: () => [structuredClone(saved)],
    remove: vi.fn(),
    save: vi.fn((record: RelayPtyOwnershipTransferDurableRecord) => {
      const fail = !!failure && failure.phase === record.sourceDeliveryRetirement?.phase
      if (!fail || failure?.when !== 'before') {
        saved = structuredClone(record)
      }
      if (fail) {
        throw new Error('retirement write uncertain')
      }
    })
  }
  const options = {
    store,
    enableDestinationDelegationClaims: true,
    enableDestinationDelegationCommit: true,
    resolveSource: () => source,
    authorizeRequest: () => false,
    setInputFenced: vi.fn(),
    writeDestinationInput: vi.fn(),
    publishDestinationOutput: vi.fn()
  }
  const state = newRelayPtyOwnershipTransferAdapterState({ options })
  let generation = 2
  claimRelayPtyOwnershipTransferDestination(state, request(generation), context())
  store.save.mockClear()
  const cleanup = {
    delivery: {
      id: identity.terminalId,
      ptyIncarnation: identity.incarnationId,
      ownerGeneration: identity.sourceOwnerGeneration,
      providerGeneration: 1,
      clientGeneration: 2,
      deliveryToken: 'source',
      state: 'active' as const,
      windowSu: 256,
      receivedEndSu: 20,
      sentEndSu: 20,
      creditedEndSu: 20,
      exitPublished: false,
      generationClosed: false
    },
    assertCurrent: vi.fn(),
    assertRemoved: vi.fn(),
    remove: vi.fn((assertAuthority: () => void) => {
      assertAuthority()
      expect(store.loadAll()[0].sourceDeliveryRetirement?.phase).toBe('prepared')
    })
  }
  const prepare = vi.fn(() => cleanup)
  const value = () => ({
    ...request(generation),
    retirementRecordSha256: 'a'.repeat(64),
    destinationClaim: { generation, claimId: `claim-${generation}` }
  })
  return {
    state,
    options,
    cleanup,
    prepare,
    store,
    value,
    run: () => retireRelayPtySourceDelivery(state, value(), context(), prepare),
    fail: (next: typeof failure) => {
      failure = next
    },
    recover: () => {
      recoverRelayPtyOwnershipTransferDestination(state, request(generation), context())
      generation++
      claimRelayPtyOwnershipTransferDestination(state, request(generation), context())
    }
  }
}

it.each([false, true])(
  'refuses covered retirement through the ordinary handler (recovery=%s)',
  (recoveryOnly) => {
    const f = setup()
    const transfer = f.state.transfers.get(identity.bridgeId)!
    // Modeled presence tests handler isolation, not durable custody validation.
    transfer.coveredSourceDeliveryRetirement = {
      phase: 'prepared',
      retirementRecordSha256: 'a'.repeat(64),
      modelSha256: 'b'.repeat(64),
      sourceOutputEndSeq: 0,
      receipt: transfer.commitReceipt!,
      delivery: f.cleanup.delivery
    }
    expect(() =>
      retireRelayPtySourceDelivery(f.state, { ...f.value(), recoveryOnly }, context(), f.prepare)
    ).toThrow('covered_recovery_required')
    expect(f.prepare).not.toHaveBeenCalled()
    expect(f.cleanup.remove).not.toHaveBeenCalled()
    expect(f.store.save).not.toHaveBeenCalled()
  }
)

it('requires a matching journal before recovery cleanup or mutation', () => {
  const f = setup()
  const run = () =>
    retireRelayPtySourceDelivery(
      f.state,
      { ...f.value(), recoveryOnly: true },
      context(),
      f.prepare
    )
  expect(run).toThrow('recovery_journal_required')
  expect(f.prepare).not.toHaveBeenCalled()
  expect(f.store.save).not.toHaveBeenCalled()
  f.run()
  f.prepare.mockClear()
  f.store.save.mockClear()
  expect(() =>
    retireRelayPtySourceDelivery(
      f.state,
      { ...f.value(), recoveryOnly: true, retirementRecordSha256: 'b'.repeat(64) },
      context(),
      f.prepare
    )
  ).toThrow('recovery_journal_required')
  expect(f.prepare).not.toHaveBeenCalled()
  expect(f.store.save).not.toHaveBeenCalled()
})

it.each(['prepared', 'retired'] as const)(
  'reconciles %s with explicit cancellation only after durable removal',
  (phase) => {
    const f = setup()
    if (phase === 'prepared') {
      f.cleanup.remove.mockImplementationOnce(() => {
        throw new Error('interrupted')
      })
      expect(f.run).toThrow('interrupted')
    } else {
      expect(f.run()).not.toHaveProperty('sourceCancellation')
    }
    f.cleanup.assertRemoved.mockClear()
    const result = retireRelayPtySourceDelivery(
      f.state,
      { ...f.value(), recoveryOnly: true },
      context(),
      f.prepare
    )
    expect(result.sourceCancellation).toEqual({ canceled: true, sentEndSu: 20, creditedEndSu: 20 })
    expect(f.cleanup.assertRemoved).toHaveBeenCalled()
    expect(f.store.loadAll()[0].sourceDeliveryRetirement?.phase).toBe('retired')
  }
)

it.each(['absence', 'write-before', 'write-after'] as const)(
  'does not confirm recovery after %s failure',
  (failure) => {
    const f = setup()
    f.run()
    if (failure === 'absence') {
      f.cleanup.assertRemoved.mockImplementation(() => {
        throw new Error('residue')
      })
    } else {
      f.fail({ phase: 'retired', when: failure === 'write-before' ? 'before' : 'after' })
    }
    expect(() =>
      retireRelayPtySourceDelivery(
        f.state,
        { ...f.value(), recoveryOnly: true },
        context(),
        f.prepare
      )
    ).toThrow()
  }
)

it('persists intent before removal and completion before acknowledgment, then reflushed retries skip cleanup', () => {
  const f = setup()
  expect(f.run().sourceDeliveryRetirement.phase).toBe('retired')
  expect(f.store.loadAll()[0].sourceDeliveryRetirement?.phase).toBe('retired')
  f.run()
  expect(f.cleanup.remove).toHaveBeenCalledOnce()
  expect(f.prepare).toHaveBeenCalledOnce()
  expect(f.store.save.mock.calls.map(([record]) => record.sourceDeliveryRetirement?.phase)).toEqual(
    ['prepared', 'retired', 'retired', 'retired']
  )
})

it.each(['token', 'cursor', 'window', 'provider'] as const)(
  'refuses expected %s mismatch before journal write or source removal',
  (field) => {
    const f = setup()
    const expectedDelivery = { ...f.cleanup.delivery }
    if (field === 'token') {
      expectedDelivery.deliveryToken = 'other'
    }
    if (field === 'cursor') {
      expectedDelivery.receivedEndSu++
      expectedDelivery.sentEndSu++
      expectedDelivery.creditedEndSu++
    }
    if (field === 'window') {
      expectedDelivery.windowSu++
    }
    if (field === 'provider') {
      expectedDelivery.providerGeneration++
    }
    expect(() =>
      retireRelayPtySourceDelivery(
        f.state,
        { ...f.value(), expectedDelivery },
        context(),
        f.prepare
      )
    ).toThrow('expected_delivery_mismatch')
    expect(f.store.save).not.toHaveBeenCalled()
    expect(f.cleanup.remove).not.toHaveBeenCalled()
  }
)

it('refuses conflicting expected delivery on retained retry without reflush or recancellation', () => {
  const f = setup()
  const expectedDelivery = { ...f.cleanup.delivery }
  retireRelayPtySourceDelivery(f.state, { ...f.value(), expectedDelivery }, context(), f.prepare)
  f.store.save.mockClear()
  f.cleanup.remove.mockClear()
  expect(() =>
    retireRelayPtySourceDelivery(
      f.state,
      {
        ...f.value(),
        expectedDelivery: { ...expectedDelivery, deliveryToken: 'other' }
      },
      context(),
      f.prepare
    )
  ).toThrow('expected_delivery_mismatch')
  expect(f.store.save).not.toHaveBeenCalled()
  expect(f.cleanup.remove).not.toHaveBeenCalled()
})

it.each([20, 21])(
  'checks locally reconstructed boundary against host cursor %s before removal',
  (hostEnd) => {
    const f = setup()
    const captureBoundary = {
      version: 1,
      identity,
      throughSeq: 0,
      delivery: { ...f.cleanup.delivery, receivedEndSu: 10, sentEndSu: 10, creditedEndSu: 10 }
    }
    const expectedDelivery = createOrcadLiveSourceRetirementDelivery({
      identity,
      captureBoundary,
      providerGeneration: 901,
      settlement: {
        ...f.cleanup.delivery,
        providerGeneration: 901,
        fromSourceEndSu: 10,
        throughSourceEndSu: 20
      }
    })
    f.cleanup.delivery.receivedEndSu = hostEnd
    f.cleanup.delivery.sentEndSu = hostEnd
    f.cleanup.delivery.creditedEndSu = hostEnd
    const run = () =>
      retireRelayPtySourceDelivery(
        f.state,
        { ...f.value(), expectedDelivery },
        context(),
        f.prepare
      )
    if (hostEnd === 20) {
      expect(run().sourceDeliveryRetirement.phase).toBe('retired')
      expect(f.cleanup.remove).toHaveBeenCalledOnce()
    } else {
      expect(run).toThrow('expected_delivery_mismatch')
      expect(f.cleanup.remove).not.toHaveBeenCalled()
      expect(f.store.save).not.toHaveBeenCalled()
    }
  }
)

it.each([
  ['prepared', 'before'],
  ['prepared', 'after'],
  ['retired', 'before'],
  ['retired', 'after']
] as const)(
  'refuses acknowledgment on %s write failure %s save and resumes after authenticated recovery',
  (phase, when) => {
    const f = setup()
    f.fail({ phase, when })
    expect(f.run).toThrow('retirement write uncertain')
    expect(f.cleanup.remove).toHaveBeenCalledTimes(phase === 'prepared' ? 0 : 1)
    const transfer = f.state.transfers.get(identity.bridgeId)!
    expect(transfer.destinationDelegationWriteUnverifiable).toBe(true)
    expect(transfer.destinationClaimBinding).toBeUndefined()
    const saves = f.store.save.mock.calls.length
    expect(f.run).toThrow('claim_unavailable')
    expect(f.store.save).toHaveBeenCalledTimes(saves)
    f.fail(undefined)
    f.recover()
    expect(f.run().sourceDeliveryRetirement.phase).toBe('retired')
    expect(f.cleanup.remove).toHaveBeenCalledOnce()
    expect(f.prepare).toHaveBeenCalledOnce()
  }
)

it.each(['credential', 'stale', 'claim'] as const)(
  'rejects %s authority before cleanup preparation or persistence',
  (kind) => {
    const f = setup()
    const value = f.value()
    const caller = context()
    if (kind === 'credential') {
      value.credential = '0'.repeat(64)
    }
    if (kind === 'stale') {
      caller.isStale = () => true
    }
    if (kind === 'claim') {
      value.destinationClaim.claimId = 'replacement'
    }
    expect(() => retireRelayPtySourceDelivery(f.state, value, caller, f.prepare)).toThrow()
    expect(f.prepare).not.toHaveBeenCalled()
    expect(f.store.save).not.toHaveBeenCalled()
  }
)

it('refuses a different coordinator retirement record on a retained attempt', () => {
  const f = setup()
  f.run()
  const saves = f.store.save.mock.calls.length
  expect(() =>
    retireRelayPtySourceDelivery(
      f.state,
      { ...f.value(), retirementRecordSha256: 'b'.repeat(64) },
      context(),
      f.prepare
    )
  ).toThrow('attempt_changed')
  expect(f.store.save).toHaveBeenCalledTimes(saves)
})

it('does not reconstruct completion merely from readable retired evidence after adapter reload', () => {
  const f = setup()
  f.run()
  const restarted = newRelayPtyOwnershipTransferAdapterState({ options: f.options })
  claimRelayPtyOwnershipTransferDestination(restarted, request(3), context())
  const prepare = vi.fn(() => ({ ...f.cleanup, assertRemoved: undefined }))
  expect(() =>
    retireRelayPtySourceDelivery(
      restarted,
      {
        ...f.value(),
        destinationClaim: { generation: 3, claimId: 'claim-3' }
      },
      context(),
      prepare
    )
  ).toThrow('restart_reconstruction_required')
  expect(prepare).toHaveBeenCalledOnce()
})

it('refuses lost destination binding after cleanup without writing completion', () => {
  const f = setup()
  const remove = f.cleanup.remove.getMockImplementation()!
  f.cleanup.remove.mockImplementationOnce((assertAuthority) => {
    remove(assertAuthority)
    f.state.transfers.get(identity.bridgeId)!.destinationClaimBinding = undefined
  })
  expect(f.run).toThrow('destination_claim_required')
  expect(f.store.loadAll()[0].sourceDeliveryRetirement?.phase).toBe('prepared')
  f.recover()
  expect(f.run().sourceDeliveryRetirement.phase).toBe('retired')
  expect(f.prepare).toHaveBeenCalledOnce()
})

it('refuses retirement evidence disappearing during cleanup', () => {
  const f = setup()
  f.cleanup.remove.mockImplementationOnce(() => {
    f.state.transfers.get(identity.bridgeId)!.sourceDeliveryRetirement = undefined
  })
  expect(f.run).toThrow('evidence_changed')
  expect(f.store.loadAll()[0].sourceDeliveryRetirement?.phase).toBe('prepared')
})
