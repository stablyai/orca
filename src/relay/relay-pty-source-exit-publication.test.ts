import { describe, expect, it, vi } from 'vitest'
import type {
  PtySourceDeliveryIdentity,
  PtySourceDeliverySnapshot
} from '../shared/pty-source-credit-contract'
import type { RelayDispatcher } from './dispatcher'
import { sealAndPublishPtySourceExit } from './relay-pty-source-exit-publication'
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
    sealDelivery: vi.fn(),
    settleExitPublication: vi.fn(),
    deliveryMode: vi.fn(() => 'source-owner' as const)
  }
  const dispatcher = {
    tryNotifyPtyExit: vi.fn(() => notifyAccepted),
    tryNotifyPtyExitToMatchingClients: vi.fn(
      (_matches: (clientId: number) => boolean, _params: unknown) => notifyAccepted
    ),
    projectPtyExitToMatchingClients: vi.fn(() => true),
    tryNotifyPtyExitToClient: vi.fn(() => true)
  }
  const sender = { pump: vi.fn() }
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
  const run = (): boolean =>
    sealAndPublishPtySourceExit({
      params,
      record,
      deliveries,
      dispatcher: dispatcher as unknown as RelayDispatcher,
      session: session as unknown as SshPtyConsumerSessionAdapter,
      sender: sender as unknown as RelayPtySourceSendScheduler,
      counters,
      onCapacity: (id) => capacityIds.push(id)
    })
  return { deliveries, session, dispatcher, sender, counters, capacityIds, run, setProbe }
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

  it.each([
    ['committed', { ok: true } as const],
    ['rolled back', { ok: false, error: new Error('socket write failed') } as const]
  ])('logs, contains and resumes after a %s ledger settlement fault', (_label, result) => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    try {
      const scenario = createInFlightScenario(closedSnapshot({ state: 'sealed-unsettled' }))
      scenario.session.settleExitPublication.mockImplementation(() => {
        throw new Error('PTY source delivery is not sealed')
      })

      expect(() => scenario.settle(result)).not.toThrow()

      expect(String(stderr.mock.calls.at(-1)?.[0])).toContain(
        '[pty-source-exit] exit settlement failed for pty-1'
      )
      expect(scenario.capacityIds).toEqual(['pty-1'])
    } finally {
      stderr.mockRestore()
    }
  })
})
