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

  it('routes five tasks through fan-in, relay, and fan-out', async () => {
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)

    const paneByHandle = new Map([
      ['term_a', 'tab_a:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
      ['term_b', 'tab_b:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'],
      ['term_c', 'tab_c:cccccccc-cccc-4ccc-8ccc-cccccccccccc'],
      ['term_d', 'tab_d:dddddddd-dddd-4ddd-8ddd-dddddddddddd'],
      ['term_e', 'tab_e:eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee']
    ])
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation(
      (handle) => paneByHandle.get(handle) ?? null
    )

    const run = db.createRun({
      objective: 'five-task collaboration graph',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:ffffffff-ffff-4fff-8fff-ffffffffffff'
    })
    const a = db.createTask({ spec: 'produce a', runId: run.id })
    const b = db.createTask({ spec: 'produce b', runId: run.id })
    const c = db.createTask({ spec: 'aggregate and relay', runId: run.id })
    const d = db.createTask({ spec: 'consume d', runId: run.id })
    const e = db.createTask({ spec: 'consume e', runId: run.id })

    for (const [task, handle] of [
      [a, 'term_a'],
      [b, 'term_b'],
      [c, 'term_c'],
      [d, 'term_d'],
      [e, 'term_e']
    ] as const) {
      db.createDispatchContext(task.id, handle, paneByHandle.get(handle)!)
    }

    registerCollaborationRuntimeTopology(
      runtime,
      run.id,
      createCollaborationTopology([
        { taskId: a.id, publishesTo: ['/input/a'], requiredPublishesTo: ['/input/a'] },
        { taskId: b.id, publishesTo: ['/input/b'], requiredPublishesTo: ['/input/b'] },
        {
          taskId: c.id,
          publishesTo: ['/result'],
          requiredPublishesTo: ['/result'],
          subscribesTo: ['/input/a', '/input/b'],
          admission: { acceptedTypes: ['input'], minPriority: 'normal' }
        },
        {
          taskId: d.id,
          subscribesTo: ['/result'],
          admission: { acceptedTypes: ['result'], minPriority: 'normal' }
        },
        {
          taskId: e.id,
          subscribesTo: ['/result'],
          admission: { acceptedTypes: ['result'], minPriority: 'normal' }
        }
      ])
    )

    const publishMethod = COLLABORATION_PUBLISH_METHODS[0]!
    const checkpointMethod = COLLABORATION_CHECKPOINT_METHODS[0]!
    const ackMethod = COLLABORATION_ACK_METHODS[0]!

    const publish = async (
      from: string,
      topic: string,
      semanticType: string,
      body: string,
      requestId: string
    ): Promise<{ subscriberTaskIds: string[]; messageIds: string[] }> => {
      const params = publishMethod.params!.parse({
        from,
        topic,
        semanticType,
        priority: 'normal',
        body
      })
      return (await publishMethod.handler(params, {
        runtime,
        orchestrationMutation: {
          callerFingerprint: 'five-task-test',
          requestId,
          method: 'orchestration.collaborationPublish',
          payloadHash: requestId
        }
      } as RpcContext)) as { subscriberTaskIds: string[]; messageIds: string[] }
    }

    const checkpoint = async (
      from: string
    ): Promise<{
      entries: { messageId: string; topic: string; body: string; producerTaskId: string }[]
    }> => {
      const params = checkpointMethod.params!.parse({ from })
      return (await checkpointMethod.handler(params, { runtime } as RpcContext)) as {
        entries: { messageId: string; topic: string; body: string; producerTaskId: string }[]
      }
    }

    const ack = async (from: string, messageIds: string[]): Promise<void> => {
      const params = ackMethod.params!.parse({ from, messageIds })
      await ackMethod.handler(params, { runtime } as RpcContext)
    }

    const rejectedByAdmission = await publish(
      'term_a',
      '/input/a',
      'result',
      'wrong type',
      'pub-rejected'
    )
    expect(rejectedByAdmission).toMatchObject({ subscriberTaskIds: [], messageIds: [] })
    expect((await checkpoint('term_c')).entries).toEqual([])
    await expect(
      publish('term_a', '/result', 'result', 'wrong route', 'pub-forbidden')
    ).rejects.toMatchObject({ code: 'collaboration_topic_not_allowed' })

    const fromA = await publish('term_a', '/input/a', 'input', 'A', 'pub-a')
    const fromB = await publish('term_b', '/input/b', 'input', 'B', 'pub-b')
    expect(fromA.subscriberTaskIds).toEqual([c.id])
    expect(fromB.subscriberTaskIds).toEqual([c.id])

    const cCheckpoint = await checkpoint('term_c')
    expect(
      cCheckpoint.entries.map((entry) => [entry.topic, entry.body, entry.producerTaskId])
    ).toEqual([
      ['/input/a', 'A', a.id],
      ['/input/b', 'B', b.id]
    ])
    expect(new Set(cCheckpoint.entries.map((entry) => entry.messageId))).toEqual(
      new Set([...fromA.messageIds, ...fromB.messageIds])
    )
    await ack(
      'term_c',
      cCheckpoint.entries.map((entry) => entry.messageId)
    )
    expect((await checkpoint('term_c')).entries).toEqual([])
    expect(db.getUnreadMessages(buildCollaborationTaskMailboxAddress(c.id))).toEqual([])

    const relay = await publish('term_c', '/result', 'result', 'A+B', 'pub-result')
    expect(relay.subscriberTaskIds).toEqual([d.id, e.id])
    expect(relay.messageIds).toHaveLength(2)
    expect(new Set(relay.messageIds).size).toBe(2)
    expect((await checkpoint('term_c')).entries).toEqual([])

    const deliveredRelayIds: string[] = []
    for (const [handle, task] of [
      ['term_d', d],
      ['term_e', e]
    ] as const) {
      const consumerCheckpoint = await checkpoint(handle)
      expect(consumerCheckpoint.entries).toHaveLength(1)
      expect(consumerCheckpoint.entries[0]).toMatchObject({
        topic: '/result',
        body: 'A+B',
        producerTaskId: c.id
      })
      const messageId = consumerCheckpoint.entries[0]!.messageId
      expect(relay.messageIds).toContain(messageId)
      deliveredRelayIds.push(messageId)
      await ack(handle, [messageId])
      expect((await checkpoint(handle)).entries).toEqual([])
      expect(db.getUnreadMessages(buildCollaborationTaskMailboxAddress(task.id))).toEqual([])
    }
    expect(new Set(deliveredRelayIds)).toEqual(new Set(relay.messageIds))
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
