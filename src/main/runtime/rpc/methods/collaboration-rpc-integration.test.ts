import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationDb } from '../../orchestration/db'
import { createCollaborationTopology } from '../../collaboration/collaboration-topology'
import { registerCollaborationRuntimeTopology } from '../../collaboration/collaboration-runtime-registry'
import { buildCollaborationTaskMailboxAddress } from '../../collaboration/collaboration-task-mailbox'
import type { RpcContext } from '../core'
import { COLLABORATION_ACK_METHODS } from './collaboration-ack'
import { COLLABORATION_CHECKPOINT_METHODS } from './collaboration-checkpoint'
import { COLLABORATION_PUBLISH_METHODS } from './collaboration-publish'

const PRODUCER_PANE = 'tab_producer:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const CONSUMER_PANE = 'tab_consumer:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

describe('local collaboration RPC integration', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService

  afterEach(() => {
    vi.restoreAllMocks()
    db.close()
  })

  it('wakes a task-scoped checkpoint from publish and then acknowledges the context', async () => {
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) => {
      if (handle === 'term_producer') {
        return PRODUCER_PANE
      }
      if (handle === 'term_consumer') {
        return CONSUMER_PANE
      }
      return null
    })

    const run = db.createRun({
      objective: 'live collaboration rpc integration',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    })
    const producer = db.createTask({ spec: 'produce', runId: run.id })
    const consumer = db.createTask({ spec: 'consume', runId: run.id })
    db.createDispatchContext(producer.id, 'term_producer', PRODUCER_PANE)
    db.createDispatchContext(consumer.id, 'term_consumer', CONSUMER_PANE)
    registerCollaborationRuntimeTopology(
      runtime,
      run.id,
      createCollaborationTopology([
        { taskId: producer.id, publishesTo: ['/finding'] },
        {
          taskId: consumer.id,
          subscribesTo: ['/finding'],
          admission: { acceptedTypes: ['finding'], minPriority: 'normal' }
        }
      ])
    )

    const checkpointMethod = COLLABORATION_CHECKPOINT_METHODS[0]!
    const checkpointParams = checkpointMethod.params!.parse({
      from: 'term_consumer',
      wait: true,
      timeoutMs: 1_000
    })
    const checkpointPromise = checkpointMethod.handler(checkpointParams, { runtime } as RpcContext)

    const publishMethod = COLLABORATION_PUBLISH_METHODS[0]!
    const publishParams = publishMethod.params!.parse({
      from: 'term_producer',
      topic: '/finding',
      semanticType: 'finding',
      priority: 'normal',
      body: 'SCHEMA=v2'
    })
    await publishMethod.handler(publishParams, {
      runtime,
      orchestrationMutation: {
        callerFingerprint: 'local-test',
        requestId: 'publication-1',
        method: 'orchestration.collaborationPublish',
        payloadHash: 'hash'
      }
    } as RpcContext)

    const checkpoint = (await checkpointPromise) as {
      entries: { messageId: string; body: string; producerTaskId: string }[]
      timedOut: boolean
      cancelled: boolean
    }
    expect(checkpoint).toMatchObject({ timedOut: false, cancelled: false })
    expect(checkpoint.entries).toHaveLength(1)
    expect(checkpoint.entries[0]).toMatchObject({
      body: 'SCHEMA=v2',
      producerTaskId: producer.id
    })

    const messageId = checkpoint.entries[0]!.messageId
    expect(db.getMessageById(messageId)?.read).toBe(0)

    const ackMethod = COLLABORATION_ACK_METHODS[0]!
    const ackParams = ackMethod.params!.parse({ from: 'term_consumer', messageIds: [messageId] })
    const ack = await ackMethod.handler(ackParams, { runtime } as RpcContext)
    expect(ack).toEqual({ messageIds: [messageId], duplicate: false })
    expect(db.getMessageById(messageId)?.read).toBe(1)
    expect(db.getUnreadMessages(buildCollaborationTaskMailboxAddress(consumer.id))).toEqual([])
  })
})
