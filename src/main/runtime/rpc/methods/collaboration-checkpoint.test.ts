import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationDb } from '../../orchestration/db'
import {
  createCollaborationTopology,
  type CollaborationTopology
} from '../../collaboration/collaboration-topology'
import { registerCollaborationRuntimeTopology } from '../../collaboration/collaboration-runtime-registry'
import { buildCollaborationTaskMailboxAddress } from '../../collaboration/collaboration-task-mailbox'
import { encodeCollaborationMessagePayload } from '../../collaboration/collaboration-message-payload'
import type { MessagePriority } from '../../orchestration/types'
import type { RpcContext } from '../core'
import { COLLABORATION_CHECKPOINT_METHODS } from './collaboration-checkpoint'

const WORKER_PANE_KEY = 'tab_worker:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const PROCESS_INCARNATION = 'runtime_test:term_worker:1'

describe('orchestration.collaborationCheckpoint', () => {
  const method = COLLABORATION_CHECKPOINT_METHODS[0]!

  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let runId: string
  let taskId: string
  let dispatchId: string

  function createTask(spec: string): string {
    return db.createTask({ spec, runId }).id
  }

  function insertMessage(
    taskId: string,
    input: {
      topic: string
      semanticType: string
      producerTaskId: string
      priority?: MessagePriority
    }
  ): string {
    return db.insertMessage({
      from: input.producerTaskId,
      to: buildCollaborationTaskMailboxAddress(taskId),
      subject: input.topic,
      body: `body:${input.topic}`,
      type: 'status',
      priority: input.priority ?? 'normal',
      payload: encodeCollaborationMessagePayload({
        version: 1,
        topic: input.topic,
        semanticType: input.semanticType,
        producerTaskId: input.producerTaskId
      })
    }).id
  }

  function topologyFor(taskId: string): CollaborationTopology {
    return createCollaborationTopology([
      {
        taskId,
        subscribesTo: ['progress'],
        admission: { acceptedTypes: ['checkpoint'], minPriority: 'high' }
      }
    ])
  }

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
    runId = db.createRun({
      objective: 'collaboration checkpoint',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    }).id
    taskId = createTask('subscriber')
    dispatchId = db.createDispatchContext(taskId, 'term_worker', WORKER_PANE_KEY).id
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

  it('derives the current task from the authenticated terminal dispatch', async () => {
    setup(() => topologyFor(taskId))
    const otherTaskId = createTask('other')
    insertMessage(taskId, {
      topic: 'progress',
      semanticType: 'checkpoint',
      producerTaskId: 'producer',
      priority: 'urgent'
    })
    insertMessage(otherTaskId, {
      topic: 'progress',
      semanticType: 'checkpoint',
      producerTaskId: 'producer',
      priority: 'urgent'
    })

    const result = (await call({ from: 'term_worker' })) as {
      entries: { body: string }[]
      filteredMessageIds: string[]
    }

    expect(result.entries.map((e) => e.body)).toEqual(['body:progress'])
    const otherMailbox = db.getAllMessages(buildCollaborationTaskMailboxAddress(otherTaskId))
    expect(otherMailbox).toHaveLength(1)
    expect(otherMailbox[0].read).toBe(0)
  })

  it('returns persisted context for unread admitted messages', async () => {
    setup(() => topologyFor(taskId))
    const id = insertMessage(taskId, {
      topic: 'progress',
      semanticType: 'checkpoint',
      producerTaskId: 'producer',
      priority: 'urgent'
    })

    const result = (await call({ from: 'term_worker' })) as {
      entries: Record<string, unknown>[]
      filteredMessageIds: string[]
    }

    expect(result.entries).toEqual([
      {
        messageId: id,
        topic: 'progress',
        semanticType: 'checkpoint',
        producerTaskId: 'producer',
        priority: 'urgent',
        body: 'body:progress'
      }
    ])
    expect(result.filteredMessageIds).toEqual([])
    const mailbox = db.getAllMessages(buildCollaborationTaskMailboxAddress(taskId))
    expect(mailbox[0].read).toBe(0)
  })

  it('filters messages that fail admission and marks them read', async () => {
    setup(() => topologyFor(taskId))
    const badId = insertMessage(taskId, {
      topic: 'progress',
      semanticType: 'notice',
      producerTaskId: 'producer',
      priority: 'normal'
    })
    insertMessage(taskId, {
      topic: 'progress',
      semanticType: 'checkpoint',
      producerTaskId: 'producer',
      priority: 'urgent'
    })

    const result = (await call({ from: 'term_worker' })) as {
      entries: Record<string, unknown>[]
      filteredMessageIds: string[]
    }

    expect(result.filteredMessageIds).toEqual([badId])
    expect(result.entries.map((e) => e.semanticType)).toEqual(['checkpoint'])
    const rows = db.getAllMessages(buildCollaborationTaskMailboxAddress(taskId))
    const filteredRow = rows.find((row) => row.id === badId)!
    expect(filteredRow.read).toBe(1)
  })

  it('rejects when no collaboration topology is registered for the run', async () => {
    setup()

    await expect(call({ from: 'term_worker' })).rejects.toMatchObject({
      code: 'collaboration_topology_unavailable'
    })
  })

  it('rejects when the task has no admission policy in the topology', async () => {
    setup(() => createCollaborationTopology([{ taskId }]))

    await expect(call({ from: 'term_worker' })).rejects.toMatchObject({
      code: 'collaboration_subscription_unavailable'
    })
  })

  it('rejects an invalid orchestration capability', async () => {
    setup(() => topologyFor(taskId))
    db.mintDispatchCapability({
      dispatchId,
      paneKey: WORKER_PANE_KEY,
      processIncarnation: PROCESS_INCARNATION
    })

    await expect(
      call({ from: 'term_worker' }, { orchestrationCapability: 'dcap_wrong' })
    ).rejects.toMatchObject({ code: 'dispatch_capability_invalid' })
  })

  it('accepts a verified orchestration capability', async () => {
    setup(() => topologyFor(taskId))
    const capability = db.mintDispatchCapability({
      dispatchId,
      paneKey: WORKER_PANE_KEY,
      processIncarnation: PROCESS_INCARNATION
    })
    insertMessage(taskId, {
      topic: 'progress',
      semanticType: 'checkpoint',
      producerTaskId: 'producer',
      priority: 'urgent'
    })

    const result = (await call(
      { from: 'term_worker' },
      { orchestrationCapability: capability }
    )) as { entries: unknown[] }

    expect(result.entries).toHaveLength(1)
  })

  it('caps the considered messages at the limit', async () => {
    setup(() => topologyFor(taskId))
    for (let i = 0; i < 3; i++) {
      insertMessage(taskId, {
        topic: 'progress',
        semanticType: 'checkpoint',
        producerTaskId: 'producer',
        priority: 'urgent'
      })
    }

    const result = (await call({ from: 'term_worker', limit: 2 })) as {
      entries: unknown[]
      filteredMessageIds: string[]
    }

    expect(result.entries).toHaveLength(2)
    expect(result.filteredMessageIds).toEqual([])
    // admitted rows are not consumed by a checkpoint read
    const rows = db.getAllMessages(buildCollaborationTaskMailboxAddress(taskId))
    expect(rows.filter((row) => row.read === 0)).toHaveLength(3)
    // the capped row is still available to the next checkpoint
    const next = (await call({ from: 'term_worker' })) as { entries: unknown[] }
    expect(next.entries).toHaveLength(3)
  })

  it('rejects an out-of-range limit', async () => {
    setup(() => topologyFor(taskId))

    expect(() => method.params!.parse({ from: 'term_worker', limit: 0 })).toThrow()
    expect(() => method.params!.parse({ from: 'term_worker', limit: 101 })).toThrow()
    expect(() => method.params!.parse({ from: 'term_worker', limit: 1.5 })).toThrow()
  })

  describe('wait support', () => {
    it('non-wait responses include timedOut and cancelled booleans', async () => {
      setup(() => topologyFor(taskId))

      const result = (await call({ from: 'term_worker' })) as Record<string, unknown>

      expect(result).toMatchObject({
        entries: [],
        filteredMessageIds: [],
        timedOut: false,
        cancelled: false
      })
    })

    it('wait:true returns immediately when an admitted entry already exists and never registers a waiter', async () => {
      setup(() => topologyFor(taskId))
      insertMessage(taskId, {
        topic: 'progress',
        semanticType: 'checkpoint',
        producerTaskId: 'producer',
        priority: 'urgent'
      })
      const wait = vi.spyOn(runtime, 'waitForMessage')

      const result = (await call({ from: 'term_worker', wait: true })) as {
        entries: unknown[]
        timedOut: boolean
        cancelled: boolean
      }

      expect(wait).not.toHaveBeenCalled()
      expect(result.entries).toHaveLength(1)
      expect(result.timedOut).toBe(false)
      expect(result.cancelled).toBe(false)
    })

    it('wait:true on an empty mailbox registers a waiter and returns a notified admitted message', async () => {
      setup(() => topologyFor(taskId))
      const wait = vi.spyOn(runtime, 'waitForMessage')
      let notifiedId = ''
      wait.mockImplementation(async (handle) => {
        expect(handle).toBe(buildCollaborationTaskMailboxAddress(taskId))
        notifiedId = insertMessage(taskId, {
          topic: 'progress',
          semanticType: 'checkpoint',
          producerTaskId: 'producer',
          priority: 'urgent'
        })
        return 'notified'
      })

      const result = (await call({ from: 'term_worker', wait: true })) as {
        entries: Record<string, unknown>[]
        timedOut: boolean
        cancelled: boolean
      }

      expect(wait).toHaveBeenCalledTimes(1)
      expect(wait.mock.calls[0]![0]).toBe(buildCollaborationTaskMailboxAddress(taskId))
      expect(result.entries).toEqual([
        {
          messageId: notifiedId,
          topic: 'progress',
          semanticType: 'checkpoint',
          producerTaskId: 'producer',
          priority: 'urgent',
          body: 'body:progress'
        }
      ])
      expect(result.timedOut).toBe(false)
      expect(result.cancelled).toBe(false)
    })

    it('consumes notified messages filtered by admission and returns the next admitted one', async () => {
      setup(() => topologyFor(taskId))
      const wait = vi.spyOn(runtime, 'waitForMessage')
      let filteredId = ''
      let admittedId = ''
      wait.mockImplementationOnce(async () => {
        filteredId = insertMessage(taskId, {
          topic: 'progress',
          semanticType: 'notice',
          producerTaskId: 'producer',
          priority: 'normal'
        })
        return 'notified'
      })
      wait.mockImplementationOnce(async () => {
        admittedId = insertMessage(taskId, {
          topic: 'progress',
          semanticType: 'checkpoint',
          producerTaskId: 'producer',
          priority: 'urgent'
        })
        return 'notified'
      })

      const result = (await call({ from: 'term_worker', wait: true })) as {
        entries: Record<string, unknown>[]
        filteredMessageIds: string[]
        timedOut: boolean
        cancelled: boolean
      }

      expect(wait).toHaveBeenCalledTimes(2)
      expect(result.filteredMessageIds).toEqual([filteredId])
      expect(result.entries).toEqual([
        {
          messageId: admittedId,
          topic: 'progress',
          semanticType: 'checkpoint',
          producerTaskId: 'producer',
          priority: 'urgent',
          body: 'body:progress'
        }
      ])
      expect(result.timedOut).toBe(false)
      expect(result.cancelled).toBe(false)
      const rows = db.getAllMessages(buildCollaborationTaskMailboxAddress(taskId))
      expect(rows.find((row) => row.id === filteredId)!.read).toBe(1)
    })

    it('wait:true times out with empty entries and timedOut set', async () => {
      setup(() => topologyFor(taskId))
      vi.spyOn(runtime, 'waitForMessage').mockResolvedValueOnce('timed_out')

      const result = (await call({ from: 'term_worker', wait: true })) as {
        entries: unknown[]
        filteredMessageIds: unknown[]
        timedOut: boolean
        cancelled: boolean
      }

      expect(result.entries).toEqual([])
      expect(result.filteredMessageIds).toEqual([])
      expect(result.timedOut).toBe(true)
      expect(result.cancelled).toBe(false)
    })

    it('wait:true cancels with empty entries and cancelled set', async () => {
      setup(() => topologyFor(taskId))
      vi.spyOn(runtime, 'waitForMessage').mockResolvedValueOnce('cancelled')

      const result = (await call({ from: 'term_worker', wait: true })) as {
        entries: unknown[]
        filteredMessageIds: unknown[]
        timedOut: boolean
        cancelled: boolean
      }

      expect(result.entries).toEqual([])
      expect(result.filteredMessageIds).toEqual([])
      expect(result.timedOut).toBe(false)
      expect(result.cancelled).toBe(true)
    })

    it('wait:true rejects with waiter_exists when another waiter holds the mailbox', async () => {
      setup(() => topologyFor(taskId))
      vi.spyOn(runtime, 'waitForMessage').mockResolvedValueOnce('waiter_exists')

      await expect(call({ from: 'term_worker', wait: true })).rejects.toMatchObject({
        code: 'waiter_exists'
      })
    })
  })
})
