import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../db'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../../shared/protocol-version'
import { ORCHESTRATION_LEGACY_RUN_ID } from '../../../../shared/orchestration-rpc-contract'
import { createRootDispatch } from './root-dispatch-test-fixture'
import type { DeliveryRow } from '../types'

const PANE_A = 'tab_a:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const PANE_B = 'tab_b:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

/**
 * Before schema v36 the `dispatch:<id>` mailbox pinned every consumer to generation 0, so the
 * `consumer_fenced` branch could never fire: a stale worker and its replacement shared one
 * outstanding Delivery and either one's ack marked the messages read for both.
 */
describe('dispatch mailbox consumer fencing', () => {
  let db: OrchestrationDb

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
  })
  afterEach(() => db.close())

  function dispatchWithMail(subjects: string[]): { id: string; runId: string } {
    const task = db.createTask({ spec: 'fenced worker work' })
    const dispatch = createRootDispatch(db, task.id, 'term_worker', PANE_A)
    for (const subject of subjects) {
      db.insertMessage({
        from: 'term_coord',
        to: `dispatch:${dispatch.id}`,
        subject,
        runId: dispatch.run_id
      })
    }
    return { id: dispatch.id, runId: dispatch.run_id }
  }

  function openDelivery(dispatchId: string, runId: string, generation: number) {
    return db.getOrCreateMailboxDelivery({
      runId,
      mailboxHandle: `dispatch:${dispatchId}`,
      consumerGeneration: generation
    })
  }

  function generationOf(dispatchId: string): number {
    return db.getDispatchContextById(dispatchId)!.consumer_generation
  }

  it('fences worker A once worker B re-attaches, and hands B the same unread mail', () => {
    const dispatch = dispatchWithMail(['first', 'second'])
    db.mintDispatchCapability({
      dispatchId: dispatch.id,
      paneKey: PANE_A,
      processIncarnation: 'runtime:pty-a:1'
    })
    const generationA = generationOf(dispatch.id)
    const deliveryA = openDelivery(dispatch.id, dispatch.runId, generationA)
    expect(deliveryA?.messages.map((message) => message.subject)).toEqual(['first', 'second'])

    db.mintDispatchCapability({
      dispatchId: dispatch.id,
      paneKey: PANE_B,
      processIncarnation: 'runtime:pty-b:1'
    })
    const generationB = generationOf(dispatch.id)
    expect(generationB).toBe(generationA + 1)
    expect(db.getDeliveryRaw(deliveryA!.delivery.id)?.status).toBe('fenced')

    expect(() =>
      db.acknowledgeMailboxDelivery({
        runId: dispatch.runId,
        mailboxHandle: `dispatch:${dispatch.id}`,
        consumerGeneration: generationA,
        deliveryId: deliveryA!.delivery.id
      })
    ).toThrow(expect.objectContaining({ code: 'consumer_fenced' }))

    const deliveryB = openDelivery(dispatch.id, dispatch.runId, generationB)
    expect(deliveryB?.delivery.id).not.toBe(deliveryA!.delivery.id)
    expect(deliveryB?.replayed).toBe(false)
    expect(deliveryB?.messages.map((message) => message.subject)).toEqual(['first', 'second'])

    db.acknowledgeMailboxDelivery({
      runId: dispatch.runId,
      mailboxHandle: `dispatch:${dispatch.id}`,
      consumerGeneration: generationB,
      deliveryId: deliveryB!.delivery.id
    })
    expect(db.getUnreadMessages(`dispatch:${dispatch.id}`)).toEqual([])
  })

  it("leaves A's ack able to strand mail unread only when B never took over", () => {
    const dispatch = dispatchWithMail(['first'])
    db.mintDispatchCapability({
      dispatchId: dispatch.id,
      paneKey: PANE_A,
      processIncarnation: 'runtime:pty-a:1'
    })
    const generation = generationOf(dispatch.id)
    const delivery = openDelivery(dispatch.id, dispatch.runId, generation)

    // A PTY restart with no re-attach must keep the live worker on its own generation.
    expect(generationOf(dispatch.id)).toBe(generation)
    const replayed = openDelivery(dispatch.id, dispatch.runId, generation)
    expect(replayed?.delivery.id).toBe(delivery!.delivery.id)
    expect(replayed?.replayed).toBe(true)
    expect(
      db.acknowledgeMailboxDelivery({
        runId: dispatch.runId,
        mailboxHandle: `dispatch:${dispatch.id}`,
        consumerGeneration: generation,
        deliveryId: delivery!.delivery.id
      }).duplicate
    ).toBe(false)
  })

  it('bumps and fences on the worker-start attach path', () => {
    const task = db.createTask({ spec: 'worker-start attach' })
    const started = db.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: task.id,
      startOptions: { topology: 'current', agent: 'codex' }
    })
    const dispatchId = started.dispatch.id
    db.insertMessage({
      from: 'term_coord',
      to: `dispatch:${dispatchId}`,
      subject: 'queued before attach',
      runId: started.dispatch.run_id
    })
    const stale = openDelivery(dispatchId, started.dispatch.run_id, 0)

    db.prepareStartingWorkerAuthority({
      dispatchId,
      handle: 'term_worker',
      paneKey: PANE_A,
      processIncarnation: 'runtime:pty-a:1',
      worktreeId: 'repo::local',
      setupState: 'not_applicable',
      effects: []
    })

    expect(generationOf(dispatchId)).toBe(1)
    expect(db.getDeliveryRaw(stale!.delivery.id)?.status).toBe('fenced')
  })

  it('gives a federated attachment its own generation on the worker host', () => {
    const dispatchId = 'ctx_remote_fence'
    db.createRemoteDispatchAttachment({
      dispatchId,
      taskId: 'task_remote',
      homePeerFingerprint: 'home-peer',
      protocolVersion: ORCHESTRATION_CONTRACT_VERSION,
      runtimeEpoch: 'epoch-1',
      mutationReceipt: {
        callerFingerprint: 'home-peer',
        requestId: 'request_remote_fence',
        method: 'orchestration.federationAttachStart',
        payloadHash: 'hash_remote_fence'
      }
    })
    db.insertMessage({
      from: 'home-peer',
      to: `dispatch:${dispatchId}`,
      subject: 'relayed before attach',
      runId: ORCHESTRATION_LEGACY_RUN_ID
    })
    const stale = openDelivery(dispatchId, ORCHESTRATION_LEGACY_RUN_ID, 0)

    // The worker host holds no dispatch_contexts row for a federated Dispatch.
    expect(db.getDispatchContextById(dispatchId)).toBeUndefined()

    db.prepareRemoteAttachmentAuthority({
      dispatchId,
      paneKey: PANE_B,
      processIncarnation: 'runtime:pty-b:1',
      worktreeId: 'repo::remote',
      terminalHandle: 'term_remote',
      setupState: 'not_applicable',
      effects: []
    })

    expect(db.getRemoteDispatchAttachment(dispatchId)?.consumer_generation).toBe(1)
    expect((db.getDeliveryRaw(stale!.delivery.id) as DeliveryRow).status).toBe('fenced')
  })

  it('starts a retry Dispatch on a fresh mailbox address rather than sharing the old one', () => {
    const task = db.createTask({ spec: 'work that fails once' })
    const first = db.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: task.id,
      startOptions: {}
    })
    db.failWorkerStart(first.dispatch.id, 'agent_readiness', 'first failed')
    const retry = db.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: task.id,
      retryOf: first.dispatch.id,
      startOptions: {}
    })

    // A retry owns a new dispatch id, so it never inherits the failed Attempt's mailbox address.
    expect(retry.dispatch.id).not.toBe(first.dispatch.id)
    expect(retry.dispatch.consumer_generation).toBe(0)
  })
})
