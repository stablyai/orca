import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../../../shared/protocol-version'
import { OrchestrationDb } from '../orchestration-db'
import { createRootDispatch } from '../root-dispatch-test-fixture'

type Settlement = 'local completion' | 'local failure' | 'remote stop' | 'remote failure'
type DeliveryOperation = 'create' | 'acknowledge'

describe('mailbox consumer lifecycle fencing', () => {
  const connections: OrchestrationDb[] = []
  const directories: string[] = []

  afterEach(() => {
    for (const db of connections.splice(0)) {
      db.close()
    }
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  function open(path: string): OrchestrationDb {
    const db = new OrchestrationDb(path)
    connections.push(db)
    return db
  }

  function databasePath(): string {
    const directory = mkdtempSync(join(tmpdir(), 'orca-mailbox-consumer-lifecycle-'))
    directories.push(directory)
    return join(directory, 'orchestration.db')
  }

  function setup(settlement: Settlement): {
    db: OrchestrationDb
    peer: OrchestrationDb
    messageId: string
    params: {
      runId: string
      mailboxHandle: string
      consumerGeneration: number
      consumerSource: 'dispatch' | 'attachment'
    }
    settle: () => void
  } {
    const path = databasePath()
    const db = open(path)
    const run = db.createRun({
      objective: 'Fence settled mailbox consumers',
      coordinatorHandle: 'coord',
      coordinatorPaneKey: 'tab:11111111-1111-4111-8111-111111111111'
    })
    const remote = settlement.startsWith('remote')
    const dispatchId = remote
      ? `ctx_${settlement.replace(' ', '_')}`
      : createRootDispatch(db, db.createTask({ runId: run.id, spec: settlement }).id, 'worker').id
    let consumerGeneration = 0

    if (remote) {
      db.createRemoteDispatchAttachment({
        runId: run.id,
        dispatchId,
        taskId: `task_${dispatchId}`,
        homePeerFingerprint: 'home-peer',
        protocolVersion: ORCHESTRATION_CONTRACT_VERSION,
        runtimeEpoch: 'epoch-1',
        mutationReceipt: {
          callerFingerprint: 'home-peer',
          requestId: `request_${dispatchId}`,
          method: 'orchestration.federationAttachStart',
          payloadHash: `hash_${dispatchId}`
        }
      })
      if (settlement === 'remote stop') {
        db.prepareRemoteAttachmentAuthority({
          dispatchId,
          paneKey: 'worker:22222222-2222-4222-9222-222222222222',
          processIncarnation: 'runtime:worker:1',
          worktreeId: 'folder',
          terminalHandle: 'worker',
          setupState: 'not_applicable',
          effects: []
        })
        db.markRemoteAttachmentReady(dispatchId)
        consumerGeneration = 1
      }
    }

    const mailboxHandle = `dispatch:${dispatchId}`
    const message = db.insertMessage({
      runId: run.id,
      from: 'coord',
      to: mailboxHandle,
      subject: 'must remain unread'
    })
    const peer = open(path)
    const settle = (): void => {
      if (settlement === 'local completion') {
        peer.completeDispatch(dispatchId)
      } else if (settlement === 'local failure') {
        peer.failDispatch(dispatchId, 'settled by peer')
      } else if (settlement === 'remote stop') {
        peer.beginRemoteAttachmentStop(dispatchId)
        peer.settleRemoteAttachmentStop(dispatchId)
      } else {
        peer.failRemoteAttachment(dispatchId, 'peer_failure', 'settled by peer', false)
      }
    }

    return {
      db,
      peer,
      messageId: message.id,
      params: {
        runId: run.id,
        mailboxHandle,
        consumerGeneration,
        consumerSource: remote ? 'attachment' : 'dispatch'
      },
      settle
    }
  }

  function currentGeneration(
    db: OrchestrationDb,
    params: {
      mailboxHandle: string
      consumerSource: 'dispatch' | 'attachment'
    }
  ): number | undefined {
    const dispatchId = params.mailboxHandle.slice('dispatch:'.length)
    return params.consumerSource === 'dispatch'
      ? db.getDispatchContextById(dispatchId)?.consumer_generation
      : db.getRemoteDispatchAttachment(dispatchId)?.consumer_generation
  }

  it.each<{
    operation: DeliveryOperation
    settlement: Settlement
  }>([
    { operation: 'create', settlement: 'local completion' },
    { operation: 'create', settlement: 'local failure' },
    { operation: 'create', settlement: 'remote stop' },
    { operation: 'create', settlement: 'remote failure' },
    { operation: 'acknowledge', settlement: 'local completion' },
    { operation: 'acknowledge', settlement: 'local failure' },
    { operation: 'acknowledge', settlement: 'remote stop' },
    { operation: 'acknowledge', settlement: 'remote failure' }
  ])('rejects $operation after $settlement on another connection', ({ operation, settlement }) => {
    const { db, peer, messageId, params, settle } = setup(settlement)
    const delivery =
      operation === 'acknowledge' ? db.getOrCreateMailboxDelivery(params)?.delivery : undefined

    settle()

    const operationCall = (): unknown =>
      operation === 'create'
        ? db.getOrCreateMailboxDelivery(params)
        : db.acknowledgeMailboxDelivery({ ...params, deliveryId: delivery!.id })
    expect(operationCall).toThrow(expect.objectContaining({ code: 'consumer_fenced' }))
    expect(db.getMessageById(messageId)?.read).toBe(0)
    expect(currentGeneration(peer, params)).toBe(params.consumerGeneration)
    if (delivery) {
      expect(db.getDeliveryRaw(delivery.id)?.acknowledged_at).toBeNull()
    }
  })

  it.each(['start_unknown', 'stop_unknown'] as const)(
    'keeps a remote %s attachment eligible to consume mail',
    (state) => {
      const path = databasePath()
      const db = open(path)
      const run = db.createRun({
        objective: 'Preserve unverifiable remote consumers',
        coordinatorHandle: 'coord',
        coordinatorPaneKey: 'tab:11111111-1111-4111-8111-111111111111'
      })
      const dispatchId = `ctx_${state}`
      db.createRemoteDispatchAttachment({
        runId: run.id,
        dispatchId,
        taskId: `task_${state}`,
        homePeerFingerprint: 'home-peer',
        protocolVersion: ORCHESTRATION_CONTRACT_VERSION,
        runtimeEpoch: 'epoch-1',
        mutationReceipt: {
          callerFingerprint: 'home-peer',
          requestId: `request_${state}`,
          method: 'orchestration.federationAttachStart',
          payloadHash: `hash_${state}`
        }
      })
      let consumerGeneration = 0
      if (state === 'start_unknown') {
        db.failRemoteAttachment(dispatchId, 'start_unknown', 'contact lost', true)
      } else {
        db.prepareRemoteAttachmentAuthority({
          dispatchId,
          paneKey: 'worker:22222222-2222-4222-9222-222222222222',
          processIncarnation: 'runtime:worker:1',
          worktreeId: 'folder',
          terminalHandle: 'worker',
          setupState: 'not_applicable',
          effects: []
        })
        db.markRemoteAttachmentReady(dispatchId)
        db.beginRemoteAttachmentStop(dispatchId)
        db.markRemoteAttachmentStopUnknown(dispatchId, 'contact lost')
        consumerGeneration = 1
      }
      const mailboxHandle = `dispatch:${dispatchId}`
      const message = db.insertMessage({
        runId: run.id,
        from: 'coord',
        to: mailboxHandle,
        subject: 'still deliverable'
      })

      expect(
        db
          .getOrCreateMailboxDelivery({
            runId: run.id,
            mailboxHandle,
            consumerGeneration,
            consumerSource: 'attachment'
          })
          ?.messages.map((row) => row.id)
      ).toEqual([message.id])
    }
  )
})
