import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationDb } from '../../orchestration/db'
import {
  createCollaborationTopology,
  type CollaborationTopology
} from '../../collaboration/collaboration-topology'
import { registerCollaborationRuntimeTopology } from '../../collaboration/collaboration-runtime-registry'
import { buildCollaborationTaskMailboxAddress } from '../../collaboration/collaboration-task-mailbox'
import type { RpcContext } from '../core'
import { COLLABORATION_PUBLISH_METHODS } from './collaboration-publish'

const WORKER_PANE_KEY = 'tab_worker:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const PROCESS_INCARNATION = 'runtime_test:term_worker:1'
const REQUEST_ID = 'request_publish'

type PublishReceipt = {
  publicationId: string
  messageIds: string[]
  subscriberTaskIds: string[]
}

describe('orchestration.collaborationPublish', () => {
  const method = COLLABORATION_PUBLISH_METHODS[0]!

  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let runId: string
  let producerTaskId: string
  let subscriberTaskIds: string[]
  let dispatchId: string

  function createTask(spec: string): string {
    return db.createTask({ spec, runId }).id
  }

  function defaultTopology(): CollaborationTopology {
    return createCollaborationTopology([
      { taskId: producerTaskId, publishesTo: ['feature-a'] },
      {
        taskId: subscriberTaskIds[0],
        subscribesTo: ['feature-a'],
        admission: { acceptedTypes: ['status'], minPriority: 'normal' }
      },
      {
        taskId: subscriberTaskIds[1],
        subscribesTo: ['feature-a'],
        admission: { acceptedTypes: ['status'], minPriority: 'normal' }
      }
    ])
  }

  // Why: topology must be built after run/task ids exist, so setup takes a
  // factory that is only evaluated once the ids are initialized.
  function setup(buildTopology?: () => CollaborationTopology): void {
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_worker' ? WORKER_PANE_KEY : null
    )
    vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockImplementation((handle) =>
      handle === 'term_worker' ? PROCESS_INCARNATION : null
    )
    vi.spyOn(runtime, 'notifyMessageArrived')
    runId = db.createRun({
      objective: 'collaboration publish',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    }).id
    producerTaskId = createTask('producer')
    subscriberTaskIds = [createTask('subscriber-a'), createTask('subscriber-b')]
    dispatchId = db.createDispatchContext(producerTaskId, 'term_worker', WORKER_PANE_KEY).id
    if (buildTopology) {
      registerCollaborationRuntimeTopology(runtime, runId, buildTopology())
    }
  }

  afterEach(() => {
    vi.restoreAllMocks()
    db.close()
  })

  async function call(
    params: Record<string, unknown>,
    ctx: Partial<RpcContext> = {}
  ): Promise<unknown> {
    const parsed = method.params!.parse(params)
    return method.handler(parsed, { runtime, ...ctx } as RpcContext)
  }

  function mutationCtx(): Partial<RpcContext> {
    return {
      orchestrationMutation: {
        callerFingerprint: 'coordinator',
        requestId: REQUEST_ID,
        method: 'orchestration.collaborationPublish',
        payloadHash: 'hash'
      }
    }
  }

  function publishParams(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      from: 'term_worker',
      topic: 'feature-a',
      semanticType: 'status',
      priority: 'high',
      body: 'hello subscribers',
      ...overrides
    }
  }

  it('publishes to derived subscribers and returns the receipt', async () => {
    setup(defaultTopology)

    const result = (await call(publishParams(), mutationCtx())) as PublishReceipt

    expect(result.publicationId).toBe(REQUEST_ID)
    expect(result.subscriberTaskIds).toEqual(subscriberTaskIds)
    expect(result.messageIds).toHaveLength(2)
    expect(vi.mocked(runtime.notifyMessageArrived)).toHaveBeenCalledTimes(2)

    for (const [index, subscriberId] of subscriberTaskIds.entries()) {
      const mailbox = buildCollaborationTaskMailboxAddress(subscriberId)
      const rows = db.getAllMessages(mailbox)
      expect(rows).toHaveLength(1)
      expect(rows[0].from_handle).toBe(buildCollaborationTaskMailboxAddress(producerTaskId))
      expect(rows[0].to_handle).toBe(mailbox)
      expect(rows[0].body).toBe('hello subscribers')
      expect(rows[0].priority).toBe('high')
      expect(rows[0].thread_id).toBe(REQUEST_ID)
      expect(vi.mocked(runtime.notifyMessageArrived)).toHaveBeenCalledWith(mailbox, rows[0].type)
      expect(result.messageIds[index]).toBe(rows[0].id)
    }
  })

  it('uses the mutation requestId as the publicationId', async () => {
    setup(defaultTopology)

    const result = (await call(publishParams(), mutationCtx())) as PublishReceipt

    expect(result.publicationId).toBe('request_publish')
  })

  it('accepts a verified orchestration capability', async () => {
    setup(defaultTopology)
    const capability = db.mintDispatchCapability({
      dispatchId,
      paneKey: WORKER_PANE_KEY,
      processIncarnation: PROCESS_INCARNATION
    })

    const result = (await call(publishParams(), {
      ...mutationCtx(),
      orchestrationCapability: capability
    })) as PublishReceipt

    expect(result.publicationId).toBe(REQUEST_ID)
  })

  it('rejects a topic outside the producer allowlist and leaves the DB empty', async () => {
    setup(defaultTopology)

    await expect(call(publishParams({ topic: 'feature-b' }), mutationCtx())).rejects.toMatchObject({
      code: 'collaboration_topic_not_allowed'
    })
    for (const subscriberId of subscriberTaskIds) {
      expect(db.getAllMessages(buildCollaborationTaskMailboxAddress(subscriberId))).toEqual([])
    }
  })

  it('rejects when no collaboration topology is registered for the run', async () => {
    setup()

    await expect(call(publishParams(), mutationCtx())).rejects.toMatchObject({
      code: 'collaboration_topology_unavailable'
    })
  })

  it('rejects an invalid orchestration capability', async () => {
    setup(defaultTopology)
    db.mintDispatchCapability({
      dispatchId,
      paneKey: WORKER_PANE_KEY,
      processIncarnation: PROCESS_INCARNATION
    })

    await expect(
      call(publishParams(), { ...mutationCtx(), orchestrationCapability: 'dcap_wrong' })
    ).rejects.toMatchObject({ code: 'dispatch_capability_invalid' })
  })

  it('rejects when there is no durable mutation context', async () => {
    setup(defaultTopology)

    await expect(call(publishParams())).rejects.toMatchObject({
      code: 'invalid_argument'
    })
  })

  it('returns an empty receipt and notifies nothing for a topic with zero subscribers', async () => {
    setup(() =>
      createCollaborationTopology([{ taskId: producerTaskId, publishesTo: ['unsubscribed-topic'] }])
    )

    const result = (await call(
      publishParams({ topic: 'unsubscribed-topic' }),
      mutationCtx()
    )) as PublishReceipt

    expect(result).toEqual({ publicationId: REQUEST_ID, messageIds: [], subscriberTaskIds: [] })
    expect(vi.mocked(runtime.notifyMessageArrived)).not.toHaveBeenCalled()
  })

  it('allows an empty body and persists it', async () => {
    setup(defaultTopology)

    await call(publishParams({ body: '' }), mutationCtx())

    for (const subscriberId of subscriberTaskIds) {
      const rows = db.getAllMessages(buildCollaborationTaskMailboxAddress(subscriberId))
      expect(rows).toHaveLength(1)
      expect(rows[0].body).toBe('')
    }
  })

  it('rejects an empty from handle', async () => {
    setup(defaultTopology)

    await expect(call(publishParams({ from: '' }), mutationCtx())).rejects.toThrow()
  })
})
