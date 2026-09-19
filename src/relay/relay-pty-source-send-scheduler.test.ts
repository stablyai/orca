import { describe, expect, it, vi } from 'vitest'
import type {
  PtySourceDeliveryIdentity,
  PtySourceDeliverySnapshot,
  PtySourceSpan
} from '../shared/pty-source-credit-contract'
import type { RelayDispatcher } from './dispatcher'
import {
  RelayPtySourceSendScheduler,
  type RelayPtySourceDeliveryRecord,
  type RelayPtySourcePublicationCounters
} from './relay-pty-source-send-scheduler'
import type { SshPtyConsumerSessionAdapter } from './ssh-pty-consumer-session-adapter'

const identity: PtySourceDeliveryIdentity = Object.freeze({
  id: 'pty-1',
  providerGeneration: 1,
  clientGeneration: 2,
  ownerGeneration: 3,
  ptyIncarnation: 'incarnation-1',
  deliveryToken: 'token-1'
})

function deliveryRecord(
  overrides: Partial<RelayPtySourceDeliveryRecord> = {}
): RelayPtySourceDeliveryRecord {
  return {
    clientId: 1,
    identity,
    sourceActivation: {
      status: 'pending',
      clientGeneration: identity.clientGeneration,
      ownerGeneration: identity.ownerGeneration,
      ptyIncarnation: identity.ptyIncarnation,
      deliveryToken: identity.deliveryToken,
      checkpointSourceEndSu: 0,
      recoveryEndSu: 0
    },
    displayEnd: 0,
    activating: false,
    activationRecoveryRequest: null,
    sealed: false,
    legacyExitAccepted: false,
    sourceExitState: 'idle',
    sending: false,
    turnFrames: 0,
    turnSourceSu: 0,
    turnScheduled: false,
    sendWaiters: new Set(),
    recoveryCheckpointSourceEndSu: null,
    recoveryEndSu: null,
    recoveryCompletionPending: false,
    restoreRequired: false,
    rotationPending: false,
    ...overrides
  }
}

function createScheduler(
  probe: PtySourceDeliverySnapshot | null,
  record: RelayPtySourceDeliveryRecord
) {
  const deliveries = new Map<string, RelayPtySourceDeliveryRecord>([['pty-1', record]])
  const session = {
    sourceDeliverySnapshotIfKnown: vi.fn(() => probe),
    sourceDeliverySnapshot: vi.fn(() => {
      throw new Error('Unknown or stale PTY source delivery')
    }),
    reserveSourceSend: vi.fn(() => null)
  }
  const dispatcher = {
    onLegacyPtyCapacity: vi.fn(() => () => {}),
    producerDataBudget: vi.fn(() => 4096),
    tryNotifyPtyDataToClient: vi.fn(() => true)
  }
  const counters: RelayPtySourcePublicationCounters = {
    opened: 0,
    rotated: 0,
    appendDenied: 0,
    sendCommitted: 0,
    sendRolledBack: 0,
    exitCommitted: 0,
    exitRolledBack: 0
  }
  const capacityIds: string[] = []
  const scheduler = new RelayPtySourceSendScheduler(
    dispatcher as unknown as RelayDispatcher,
    session as unknown as SshPtyConsumerSessionAdapter,
    deliveries,
    counters,
    (id) => capacityIds.push(id)
  )
  return { scheduler, deliveries, session, capacityIds }
}

describe('RelayPtySourceSendScheduler close handling', () => {
  it('leaves an in-flight exit frame untouched on a credit event', () => {
    const record = deliveryRecord({ sourceExitState: 'pending' })
    const harness = createScheduler(null, record)

    harness.scheduler.onCreditAvailable('pty-1')

    expect(harness.deliveries.get('pty-1')).toBe(record)
    expect(harness.session.sourceDeliverySnapshotIfKnown).not.toHaveBeenCalled()
    expect(harness.session.reserveSourceSend).not.toHaveBeenCalled()
    expect(harness.capacityIds).toEqual([])
  })

  it('prunes a record whose tombstone was already evicted', () => {
    const waiter = vi.fn()
    const record = deliveryRecord({ sendWaiters: new Set([waiter]) })
    const harness = createScheduler(null, record)

    expect(() => harness.scheduler.onCreditAvailable('pty-1')).not.toThrow()

    expect(waiter).toHaveBeenCalledOnce()
    expect(record.sendWaiters.size).toBe(0)
    expect(harness.deliveries.has('pty-1')).toBe(false)
    expect(harness.capacityIds).toEqual(['pty-1'])
  })

  it('preserves a closed record after the legacy exit projection landed', () => {
    const record = deliveryRecord({ legacyExitAccepted: true })
    const harness = createScheduler(null, record)

    harness.scheduler.onCreditAvailable('pty-1')

    expect(harness.deliveries.get('pty-1')).toBe(record)
    expect(harness.session.reserveSourceSend).not.toHaveBeenCalled()
    expect(harness.capacityIds).toEqual(['pty-1'])
  })

  it('prunes a healthily published exit after its final credit closes the delivery', () => {
    const record = deliveryRecord({
      legacyExitAccepted: true,
      sourceExitState: 'published'
    })
    const harness = createScheduler(null, record)

    harness.scheduler.onCreditAvailable('pty-1')

    expect(harness.deliveries.has('pty-1')).toBe(false)
    expect(harness.capacityIds).toEqual(['pty-1'])
  })

  it('skips unknown deliveries in the debug snapshot instead of throwing', () => {
    const harness = createScheduler(null, deliveryRecord({ sealed: true }))

    expect(harness.scheduler.getDebugSnapshot()).toMatchObject({
      active: 0,
      activating: 0,
      sealedUnsettled: 0,
      outstandingSourceUnits: 0
    })
  })
})

describe('RelayPtySourceSendScheduler transfer envelopes', () => {
  it('accounts for and emits an optional ownership-transfer envelope under credit', () => {
    const record = deliveryRecord()
    const transfer = {
      bridgeId: 'bridge-1',
      terminalId: identity.id,
      incarnationId: identity.ptyIncarnation,
      ownerLease: 'lease-1',
      sourceOwnerGeneration: identity.ownerGeneration,
      destinationRuntimeId: 'runtime-1',
      version: 1 as const,
      frameSeq: 4,
      fragmentStartSu: 0,
      fragmentEndSu: 4,
      frameLengthSu: 4
    }
    const span: PtySourceSpan = Object.freeze({
      ...identity,
      spanId: 'span-1',
      sourceStartSu: 0,
      sourceEndSu: 4,
      displayStart: 0,
      displayEnd: 4,
      data: 'data',
      ownershipTransfer: transfer,
      splittable: true,
      transform: { transformed: false, rawLengthSu: 4, scalarSafe: true }
    })
    const reservation = Object.freeze({ reservationId: 'r1', identity, span })
    const session = {
      sourceDeliverySnapshot: vi.fn(() => ({
        ...identity,
        state: 'active' as const,
        windowSu: 64,
        receivedEndSu: 4,
        sentEndSu: 0,
        creditedEndSu: 0,
        exitPublished: false,
        generationClosed: false
      })),
      sourceDeliverySnapshotIfKnown: vi.fn(() => null),
      reserveSourceSend: vi.fn(() => reservation),
      commitSourceSend: vi.fn(),
      rollbackSourceSend: vi.fn()
    }
    const sent: Record<string, unknown>[] = []
    const dispatcher = {
      onLegacyPtyCapacity: vi.fn(() => () => {}),
      producerDataBudget: vi.fn(() => 4096),
      tryNotifyPtyDataToClient: vi.fn((_clientId, params, settle) => {
        sent.push(params)
        settle({ ok: true })
        return true
      })
    }
    const counters: RelayPtySourcePublicationCounters = {
      opened: 0,
      rotated: 0,
      appendDenied: 0,
      sendCommitted: 0,
      sendRolledBack: 0,
      exitCommitted: 0,
      exitRolledBack: 0
    }
    const scheduler = new RelayPtySourceSendScheduler(
      dispatcher as unknown as RelayDispatcher,
      session as unknown as SshPtyConsumerSessionAdapter,
      new Map([['pty-1', record]]),
      counters,
      vi.fn()
    )

    scheduler.pump(record)

    expect(dispatcher.producerDataBudget).toHaveBeenCalledTimes(2)
    const budgetCalls = dispatcher.producerDataBudget.mock.calls as unknown as unknown[][]
    expect(budgetCalls[1]?.[1]).toMatchObject({
      ownershipTransfer: expect.objectContaining({ bridgeId: 'bridge-1' })
    })
    expect(sent[0]).toMatchObject({
      data: 'data',
      ownershipTransfer: expect.objectContaining({ frameSeq: 4 })
    })
    expect(session.commitSourceSend).toHaveBeenCalledWith(reservation)
  })
})
