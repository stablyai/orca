import { describe, expect, it, vi } from 'vitest'
import type {
  PtySourceDeliveryIdentity,
  PtySourceDeliverySnapshot
} from '../shared/pty-source-credit-contract'
import type { RelayDispatcher } from './dispatcher'
import {
  RelayPtySourceLegacyExitIndex,
  sealAndPublishPtySourceExit,
  sealAndPublishTrackedPtySourceExit
} from './relay-pty-source-exit-publication'
import type {
  RelayPtySourceDeliveryRecord,
  RelayPtySourcePublicationCounters,
  RelayPtySourceSendScheduler
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

const params = { id: 'pty-1', code: 0, incarnationId: 'incarnation-1' }

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

function closedSnapshot(
  overrides: Partial<PtySourceDeliverySnapshot> = {}
): PtySourceDeliverySnapshot {
  return Object.freeze({
    ...identity,
    state: 'closed',
    windowSu: 8,
    receivedEndSu: 0,
    sentEndSu: 0,
    creditedEndSu: 0,
    exitPublished: false,
    generationClosed: false,
    ...overrides
  })
}

function createScenario(
  initialProbe: PtySourceDeliverySnapshot | null,
  record: RelayPtySourceDeliveryRecord,
  notifyAccepted = true
) {
  const deliveries = new Map<string, RelayPtySourceDeliveryRecord>([['pty-1', record]])
  let probe = initialProbe
  const setProbe = (next: PtySourceDeliverySnapshot | null): void => {
    probe = next
  }
  const session = {
    sourceDeliverySnapshotIfKnown: vi.fn(() => probe),
    sourceDeliverySnapshot: vi.fn(() => {
      if (!probe) {
        throw new Error('Unknown or stale PTY source delivery')
      }
      return probe
    }),
    cancelDelivery: vi.fn(),
    sealDelivery: vi.fn(),
    settleExitPublication: vi.fn(),
    deliveryMode: vi.fn(() => 'source-owner' as const)
  }
  const dispatcher = {
    tryNotifyPtyExit: vi.fn(() => notifyAccepted),
    tryNotifyPtyExitToMatchingClients: vi.fn(
      (_matches: (clientId: number) => boolean, _params: unknown) => notifyAccepted
    ),
    projectPtyExitToLegacyClients: vi.fn(() => true),
    tryNotifyPtyExitToClient: vi.fn(() => true)
  }
  const sender = { pump: vi.fn(), wakeSendWaiters: vi.fn() }
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
  let capacityError: Error | null = null
  const onCapacity = (id: string): void => {
    capacityIds.push(id)
    if (capacityError) {
      throw capacityError
    }
  }
  const run = (): boolean =>
    sealAndPublishPtySourceExit({
      params,
      record,
      deliveries,
      dispatcher: dispatcher as unknown as RelayDispatcher,
      session: session as unknown as SshPtyConsumerSessionAdapter,
      sender: sender as unknown as RelayPtySourceSendScheduler,
      counters,
      onCapacity
    })
  const runTracked = (legacyExits: RelayPtySourceLegacyExitIndex): boolean =>
    sealAndPublishTrackedPtySourceExit({
      params,
      legacyExits,
      deliveries,
      dispatcher: dispatcher as unknown as RelayDispatcher,
      session: session as unknown as SshPtyConsumerSessionAdapter,
      sender: sender as unknown as RelayPtySourceSendScheduler,
      counters,
      onCapacity
    })
  return {
    deliveries,
    session,
    dispatcher,
    sender,
    counters,
    capacityIds,
    run,
    runTracked,
    setProbe,
    setCapacityError: (error: Error): void => {
      capacityError = error
    }
  }
}

describe('sealAndPublishPtySourceExit closed-delivery guard', () => {
  it.each([
    ['an unknown probe', null],
    ['a closed probe', closedSnapshot()],
    ['a closing probe', closedSnapshot({ state: 'closing' })]
  ])('broadcasts a legacy exit and retires the record for %s', (_label, probe) => {
    const record = deliveryRecord()
    const scenario = createScenario(probe, record)

    expect(scenario.run()).toBe(true)

    expect(scenario.dispatcher.tryNotifyPtyExit).toHaveBeenCalledWith(params)
    expect(scenario.dispatcher.tryNotifyPtyExitToMatchingClients).not.toHaveBeenCalled()
    expect(scenario.session.sealDelivery).not.toHaveBeenCalled()
    expect(scenario.session.settleExitPublication).not.toHaveBeenCalled()
    expect(scenario.sender.pump).not.toHaveBeenCalled()
    expect(scenario.deliveries.has('pty-1')).toBe(false)
  })

  it('re-targets only source-owner clients once a legacy broadcast already landed', () => {
    const record = deliveryRecord({ legacyExitAccepted: true })
    const scenario = createScenario(closedSnapshot(), record)

    expect(scenario.run()).toBe(true)

    expect(scenario.dispatcher.tryNotifyPtyExit).not.toHaveBeenCalled()
    const matches = scenario.dispatcher.tryNotifyPtyExitToMatchingClients.mock.calls[0][0]
    expect(matches(1)).toBe(true)
    scenario.session.deliveryMode.mockReturnValue('legacy-owner' as never)
    expect(matches(1)).toBe(false)
    expect(scenario.deliveries.has('pty-1')).toBe(false)
  })

  it('keeps the record retryable when the legacy notify is refused', () => {
    const record = deliveryRecord()
    const scenario = createScenario(closedSnapshot(), record, false)

    expect(scenario.run()).toBe(false)

    expect(scenario.deliveries.get('pty-1')).toBe(record)
  })

  it.each([
    ['the tombstone retains exitPublished', closedSnapshot({ exitPublished: true }), 'idle'],
    ['the tombstone was evicted', null, 'published']
  ])('retires a healthily completed delivery silently when %s', (_label, probe, exitState) => {
    const record = deliveryRecord({
      sourceExitState: exitState as RelayPtySourceDeliveryRecord['sourceExitState']
    })
    const scenario = createScenario(probe, record)

    expect(scenario.run()).toBe(true)

    expect(scenario.dispatcher.tryNotifyPtyExit).not.toHaveBeenCalled()
    expect(scenario.dispatcher.tryNotifyPtyExitToMatchingClients).not.toHaveBeenCalled()
    expect(scenario.sender.pump).not.toHaveBeenCalled()
    expect(scenario.deliveries.has('pty-1')).toBe(false)
  })

  it('defers to the in-flight exit frame settlement', () => {
    const record = deliveryRecord({ sourceExitState: 'pending' })
    const scenario = createScenario(closedSnapshot(), record)

    expect(scenario.run()).toBe(false)

    expect(scenario.session.sourceDeliverySnapshotIfKnown).not.toHaveBeenCalled()
    expect(scenario.dispatcher.tryNotifyPtyExit).not.toHaveBeenCalled()
    expect(scenario.deliveries.get('pty-1')).toBe(record)
  })
})

describe('RelayPtySourceLegacyExitIndex', () => {
  function createIndex(notifyAccepted = true) {
    const index = new RelayPtySourceLegacyExitIndex()
    const dispatcher = {
      tryNotifyPtyExitToMatchingClients: vi.fn(
        (_matches: (clientId: number) => boolean, _params: unknown) => notifyAccepted
      )
    }
    const session = { deliveryMode: vi.fn(() => 'source-owner' as const) }
    const publish = (): boolean | null =>
      index.publishAfterRetire(
        params,
        dispatcher as unknown as RelayDispatcher,
        session as unknown as SshPtyConsumerSessionAdapter
      )
    return { index, dispatcher, session, publish }
  }

  it('defers to the caller when nothing was projected for the pty', () => {
    const scenario = createIndex()

    expect(scenario.publish()).toBeNull()

    expect(scenario.dispatcher.tryNotifyPtyExitToMatchingClients).not.toHaveBeenCalled()
  })

  it('re-targets the owner exactly once for a remembered projection', () => {
    const scenario = createIndex()
    scenario.index.remember(params, true)

    expect(scenario.publish()).toBe(true)

    const matches = scenario.dispatcher.tryNotifyPtyExitToMatchingClients.mock.calls[0][0]
    expect(matches(1)).toBe(true)
    scenario.session.deliveryMode.mockReturnValue('legacy-owner' as never)
    expect(matches(1)).toBe(false)
    // Why: the second pass is the handler's retry after a later capacity event; re-publishing
    // would hand the owner a duplicate exit.
    expect(scenario.publish()).toBeNull()
  })

  it('keeps the projection retryable when the owner notify is refused', () => {
    const scenario = createIndex(false)
    scenario.index.remember(params, true)

    expect(scenario.publish()).toBe(false)
    expect(scenario.publish()).toBe(false)
  })

  it('consumes a completed retired exit without publishing it again', () => {
    const scenario = createIndex()
    scenario.index.remember(params, true)
    scenario.index.complete(params)

    expect(scenario.publish()).toBe(true)
    expect(scenario.dispatcher.tryNotifyPtyExitToMatchingClients).not.toHaveBeenCalled()
    expect(scenario.publish()).toBeNull()
  })

  it('does not let stale completion overwrite a later incarnation', () => {
    const scenario = createIndex()
    const next = { ...params, incarnationId: 'incarnation-2' }
    scenario.index.remember(next, true)

    scenario.index.complete(params)

    expect(scenario.publish()).toBeNull()
    expect(
      scenario.index.publishAfterRetire(
        next,
        scenario.dispatcher as unknown as RelayDispatcher,
        scenario.session as unknown as SshPtyConsumerSessionAdapter
      )
    ).toBe(true)
  })

  it('keeps the exit pending when the subscriber projection is refused', () => {
    const record = deliveryRecord({ sealed: true })
    const scenario = createScenario(closedSnapshot({ state: 'sealed-unsettled' }), record)
    scenario.dispatcher.projectPtyExitToLegacyClients.mockReturnValueOnce(false)

    expect(scenario.run()).toBe(false)
    expect(record.legacyExitAccepted).toBe(false)
    expect(record.sourceExitState).toBe('idle')
    expect(scenario.dispatcher.tryNotifyPtyExitToClient).not.toHaveBeenCalled()

    // The handler's retry after drain lands the exit once, with no duplicate legacy projection.
    expect(scenario.run()).toBe(true)
    expect(record.legacyExitAccepted).toBe(true)
    expect(scenario.dispatcher.projectPtyExitToLegacyClients).toHaveBeenCalledTimes(2)
    expect(scenario.dispatcher.tryNotifyPtyExitToClient).toHaveBeenCalledOnce()
  })

  it('remembers a subscriber projection when the owner publication throws', () => {
    const record = deliveryRecord({ sealed: true })
    const scenario = createScenario(closedSnapshot({ state: 'sealed-unsettled' }), record)
    const index = new RelayPtySourceLegacyExitIndex()
    scenario.dispatcher.tryNotifyPtyExitToClient.mockImplementation(() => {
      throw new Error('owner write failed')
    })

    expect(() => scenario.runTracked(index)).toThrow('owner write failed')
    expect(scenario.dispatcher.projectPtyExitToLegacyClients).toHaveBeenCalledOnce()
    expect(scenario.session.cancelDelivery).toHaveBeenCalledWith(
      record.identity,
      'exit-publication-failed'
    )
    expect(scenario.deliveries.has(params.id)).toBe(false)
    expect(
      index.publishAfterRetire(
        params,
        scenario.dispatcher as unknown as RelayDispatcher,
        scenario.session as unknown as SshPtyConsumerSessionAdapter
      )
    ).toBe(true)
    expect(scenario.dispatcher.tryNotifyPtyExit).not.toHaveBeenCalled()
    expect(
      index.publishAfterRetire(
        params,
        scenario.dispatcher as unknown as RelayDispatcher,
        scenario.session as unknown as SshPtyConsumerSessionAdapter
      )
    ).toBeNull()
  })

  it.each([
    [
      'a later incarnation reused the pty id',
      (index: RelayPtySourceLegacyExitIndex) =>
        index.remember({ ...params, incarnationId: 'incarnation-2' }, true)
    ],
    [
      'the projection was withdrawn',
      (index: RelayPtySourceLegacyExitIndex) => index.remember(params, false)
    ],
    [
      'the exit completed for every client',
      (index: RelayPtySourceLegacyExitIndex) => index.forget(params.id)
    ],
    ['the publication was disposed', (index: RelayPtySourceLegacyExitIndex) => index.clear()]
  ])('defers to the caller once %s', (_label, mutate) => {
    const scenario = createIndex()
    scenario.index.remember(params, true)

    mutate(scenario.index)

    expect(scenario.publish()).toBeNull()
  })
})

describe('sealAndPublishPtySourceExit settlement closure', () => {
  function createInFlightScenario(settlementProbe: PtySourceDeliverySnapshot | null) {
    const record = deliveryRecord({ sealed: true, legacyExitAccepted: true })
    const scenario = createScenario(closedSnapshot({ state: 'sealed-unsettled' }), record)
    let settle: ((result: { ok: true } | { ok: false; error: Error }) => void) | undefined
    scenario.dispatcher.tryNotifyPtyExitToClient.mockImplementation(
      (...args: unknown[]): boolean => {
        settle = args[2] as typeof settle
        return true
      }
    )
    expect(scenario.run()).toBe(true)
    scenario.setProbe(settlementProbe)
    return { ...scenario, record, settle: settle! }
  }

  it('skips the ledger settle and still resumes capacity when the delivery vanished', () => {
    const scenario = createInFlightScenario(null)

    expect(() => scenario.settle({ ok: true })).not.toThrow()

    expect(scenario.session.settleExitPublication).not.toHaveBeenCalled()
    expect(scenario.record.sourceExitState).toBe('published')
    expect(scenario.capacityIds).toEqual(['pty-1'])
  })

  it('resumes capacity on a failed settlement once the delivery is gone', () => {
    const scenario = createInFlightScenario(closedSnapshot())

    scenario.settle({ ok: false, error: new Error('socket write failed') })

    expect(scenario.session.settleExitPublication).not.toHaveBeenCalled()
    expect(scenario.record.sourceExitState).toBe('idle')
    expect(scenario.capacityIds).toEqual(['pty-1'])
  })

  it('retains committed completion until a failed capacity signal is retried', () => {
    const record = deliveryRecord({ sealed: true })
    const scenario = createScenario(closedSnapshot({ state: 'sealed-unsettled' }), record)
    const index = new RelayPtySourceLegacyExitIndex()
    let settle: ((result: { ok: true }) => void) | undefined
    scenario.dispatcher.tryNotifyPtyExitToClient.mockImplementation((...args: unknown[]) => {
      settle = args[2] as typeof settle
      return true
    })
    scenario.session.settleExitPublication.mockImplementation(() => {
      throw new Error('PTY source delivery is not sealed')
    })
    scenario.setCapacityError(new Error('capacity callback failed'))
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    try {
      expect(scenario.runTracked(index)).toBe(true)
      expect(() => settle!({ ok: true })).not.toThrow()

      expect(
        index.publishAfterRetire(
          params,
          scenario.dispatcher as unknown as RelayDispatcher,
          scenario.session as unknown as SshPtyConsumerSessionAdapter
        )
      ).toBe(true)
      expect(scenario.dispatcher.tryNotifyPtyExitToMatchingClients).not.toHaveBeenCalled()
      expect(
        index.publishAfterRetire(
          params,
          scenario.dispatcher as unknown as RelayDispatcher,
          scenario.session as unknown as SshPtyConsumerSessionAdapter
        )
      ).toBeNull()
    } finally {
      stderr.mockRestore()
    }
  })

  it.each([
    ['committed', { ok: true } as const],
    ['rolled back', { ok: false, error: new Error('socket write failed') } as const]
  ])('logs, contains and resumes after a %s ledger settlement fault', (_label, result) => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    try {
      const scenario = createInFlightScenario(closedSnapshot({ state: 'sealed-unsettled' }))
      scenario.record.sendWaiters.add(vi.fn())
      scenario.session.settleExitPublication.mockImplementation(() => {
        throw new Error('PTY source delivery is not sealed')
      })
      scenario.sender.wakeSendWaiters.mockImplementation(() => {
        throw new Error('send waiter failed')
      })
      scenario.setCapacityError(new Error('capacity callback failed'))

      expect(() => scenario.settle(result)).not.toThrow()

      expect(String(stderr.mock.calls.at(-1)?.[0])).toContain(
        '[pty-source-exit] exit settlement failed for pty-1'
      )
      expect(scenario.capacityIds).toEqual(['pty-1'])
      expect(scenario.session.cancelDelivery).toHaveBeenCalledWith(
        scenario.record.identity,
        'exit-publication-failed'
      )
      expect(scenario.deliveries.has(params.id)).toBe(false)
      expect(scenario.record.sendWaiters.size).toBe(0)
    } finally {
      stderr.mockRestore()
    }
  })
})
