import { expect, it } from 'vitest'
import type { RelayDispatcher, SinkWriteSettlement } from './dispatcher'
import type { SshPtyConsumerSessionAdapter } from './ssh-pty-consumer-session-adapter'
import {
  RelayPtySourceSendScheduler,
  type RelayPtySourceDeliveryRecord
} from './relay-pty-source-send-scheduler'

it('retries an unadmitted recovery completion once capacity returns', () => {
  let capacityListener = () => {}
  let listenerRemoved = false
  let admissions = 0
  const completionSettlements: ((result: SinkWriteSettlement) => void)[] = []
  const dispatcher = {
    onLegacyPtyCapacity(listener: () => void) {
      capacityListener = listener
      return () => {
        listenerRemoved = true
      }
    },
    tryNotifyClient(
      _clientId: number,
      _method: string,
      _params: Record<string, unknown>,
      onSettled: (result: SinkWriteSettlement) => void
    ) {
      admissions++
      if (admissions === 1) {
        return false
      }
      completionSettlements.push(onSettled)
      return true
    },
    producerDataBudget: () => 1024,
    tryNotifyPtyDataToClient: () => false
  } as unknown as RelayDispatcher
  const session = {
    sourceDeliverySnapshot: () => ({ sentEndSu: 4, state: 'active' }),
    reserveSourceSend: () => null,
    cancelDelivery: () => {}
  } as unknown as SshPtyConsumerSessionAdapter
  const record: RelayPtySourceDeliveryRecord = {
    clientId: 1,
    identity: {
      id: 'pty-1',
      providerGeneration: 1,
      clientGeneration: 1,
      ownerGeneration: 1,
      ptyIncarnation: 'incarnation-1',
      deliveryToken: 'token-1'
    },
    sourceActivation: {
      status: 'pending',
      clientGeneration: 1,
      ownerGeneration: 1,
      ptyIncarnation: 'incarnation-1',
      deliveryToken: 'token-1',
      checkpointSourceEndSu: 0,
      recoveryEndSu: 4
    },
    displayEnd: 4,
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
    recoveryCheckpointSourceEndSu: 0,
    recoveryEndSu: 4,
    recoveryCompletionPending: false,
    restoreRequired: false,
    rotationPending: false
  }
  const deliveries = new Map([['pty-1', record]])
  let capacityCalls = 0
  const scheduler = new RelayPtySourceSendScheduler(
    dispatcher,
    session,
    deliveries,
    {
      opened: 0,
      rotated: 0,
      appendDenied: 0,
      sendCommitted: 0,
      sendRolledBack: 0,
      exitCommitted: 0,
      exitRolledBack: 0
    },
    () => {
      capacityCalls++
    }
  )

  scheduler.completeRecoveryIfReady(record)
  expect(admissions).toBe(1)
  expect(record.recoveryCompletionPending).toBe(false)
  expect(record.recoveryEndSu).toBe(4)

  capacityListener()
  capacityListener()
  expect(admissions).toBe(2)
  expect(completionSettlements).toHaveLength(1)
  expect(record.recoveryCompletionPending).toBe(true)

  completionSettlements[0]({ ok: true })
  capacityListener()
  expect(admissions).toBe(2)
  expect(record.recoveryEndSu).toBeNull()
  expect(capacityCalls).toBe(1)

  scheduler.dispose()
  expect(listenerRemoved).toBe(true)
})
