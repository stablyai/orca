import { expect, it, vi } from 'vitest'
import { RelayPtyOwnershipTransferSourceResolver } from './relay-pty-ownership-transfer-source-resolution'
import type { RelayPtySourceDeliveryRecord } from './relay-pty-source-send-scheduler'
import type { SshPtyConsumerSessionAdapter } from './ssh-pty-consumer-session-adapter'
import type { PtySourceDeliverySnapshot } from '../shared/pty-source-credit-contract'
import { createPtySourceReceivingActivation } from './relay-pty-source-activation'

function setup() {
  const identity = {
    id: 'pty',
    providerGeneration: 1,
    clientGeneration: 2,
    ownerGeneration: 3,
    ptyIncarnation: 'incarnation',
    deliveryToken: 'token'
  }
  const record: RelayPtySourceDeliveryRecord = {
    clientId: 4,
    identity,
    sourceActivation: createPtySourceReceivingActivation(identity, 0, 0),
    displayEnd: 15,
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
    rotationPending: false
  }
  const snapshot: PtySourceDeliverySnapshot = {
    ...identity,
    state: 'active',
    windowSu: 256,
    receivedEndSu: 20,
    sentEndSu: 20,
    creditedEndSu: 20,
    exitPublished: false,
    generationClosed: false
  }
  const source = {
    terminalId: 'pty',
    incarnationId: 'incarnation',
    ownerLease: 'lease',
    sourceOwnerGeneration: 3
  }
  const owners = new Map([[4, { ownerLease: 'lease', ownerGeneration: 3 }]])
  const sourceDeliverySnapshot = vi.fn(() => snapshot)
  const session = { activeSessionOwner: (id: number) => owners.get(id), sourceDeliverySnapshot }
  const deliveries = new Map([['pty', record]])
  const resolver = new RelayPtyOwnershipTransferSourceResolver(
    deliveries,
    session as unknown as SshPtyConsumerSessionAdapter
  )
  return { resolver, record, snapshot, source, owners, deliveries, sourceDeliverySnapshot }
}

it('returns exact immutable settled delivery evidence without installing a rotation fence', () => {
  const fixture = setup()
  const evidence = fixture.resolver.inspectDrainedDelivery(fixture.source, 4)
  expect(evidence).toEqual(fixture.snapshot)
  expect(evidence).not.toBe(fixture.snapshot)
  expect(Object.isFrozen(evidence)).toBe(true)
  expect(fixture.record.rotationPending).toBe(false)
  expect(fixture.record.sendWaiters.size).toBe(0)
})

it.each([
  { activating: true },
  { rotationPending: true },
  { restoreRequired: true },
  { sealed: true },
  { sending: true },
  { turnScheduled: true },
  { sourceExitState: 'pending' as const },
  { recoveryEndSu: 20 },
  { recoveryCompletionPending: true }
])('refuses unsettled delivery lifecycle: %j', (patch) => {
  const fixture = setup()
  Object.assign(fixture.record, patch)
  expect(fixture.resolver.inspectDrainedDelivery(fixture.source, 4)).toBeNull()
  expect(fixture.sourceDeliverySnapshot).not.toHaveBeenCalled()
})

it.each([
  { receivedEndSu: 21 },
  { creditedEndSu: 19 },
  { state: 'closed' as const },
  { state: 'sealed-unsettled' as const },
  { generationClosed: true },
  { exitPublished: true },
  { deliveryToken: 'other' },
  { clientGeneration: 9 },
  { providerGeneration: 9 },
  { ptyIncarnation: 'other' },
  { receivedEndSu: -1, sentEndSu: -1, creditedEndSu: -1 }
])('refuses incomplete or superseded ledger evidence: %j', (patch) => {
  const fixture = setup()
  Object.assign(fixture.snapshot, patch)
  expect(fixture.resolver.inspectDrainedDelivery(fixture.source, 4)).toBeNull()
})

it('requires the exact client, lease, generation and incarnation before reading the ledger', () => {
  const fixture = setup()
  expect(fixture.resolver.inspectDrainedDelivery(fixture.source, 5)).toBeNull()
  for (const patch of [
    { ownerLease: 'other' },
    { sourceOwnerGeneration: 2 },
    { incarnationId: 'other' }
  ]) {
    expect(fixture.resolver.inspectDrainedDelivery({ ...fixture.source, ...patch }, 4)).toBeNull()
  }
  expect(fixture.sourceDeliverySnapshot).not.toHaveBeenCalled()
})

it.each(['owner', 'record', 'missing', 'throws'])(
  'refuses authority lost during ledger inspection: %s',
  (mode) => {
    const fixture = setup()
    fixture.sourceDeliverySnapshot.mockImplementation(() => {
      if (mode === 'owner') {
        fixture.owners.delete(4)
      }
      if (mode === 'record') {
        fixture.deliveries.set('pty', { ...fixture.record })
      }
      if (mode === 'missing') {
        fixture.deliveries.delete('pty')
      }
      if (mode === 'throws') {
        throw new Error('delivery unavailable')
      }
      return fixture.snapshot
    })
    expect(fixture.resolver.inspectDrainedDelivery(fixture.source, 4)).toBeNull()
  }
)
