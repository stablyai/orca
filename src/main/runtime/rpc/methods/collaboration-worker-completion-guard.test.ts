import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcContext } from '../core'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationDb } from '../../orchestration/db'
import { createCollaborationTopology } from '../../collaboration/collaboration-topology'
import { registerCollaborationRuntimeTopology } from '../../collaboration/collaboration-runtime-registry'
import { publishCollaborationMessage } from '../../collaboration/collaboration-publish-store'
import { ORCHESTRATION_METHODS } from './orchestration'

const PRODUCER_PANE = 'tab_producer:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const COORDINATOR_PANE = 'tab_coord:cccccccc-cccc-4ccc-8ccc-cccccccccccc'

type Fixture = {
  db: OrchestrationDb
  runtime: OrcaRuntimeService
  runId: string
  producerTaskId: string
  subscriberTaskId: string
  dispatchId: string
}

// Why: real OrcaRuntimeService + in-memory OrchestrationDb, collaboration
// topology with a required publish, and orchestration.send as the entry point.
describe('collaboration worker completion guard', () => {
  let db: OrchestrationDb | undefined
  let runtime: OrcaRuntimeService | undefined

  function setup(): Fixture {
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_producer' ? PRODUCER_PANE : null
    )

    const run = db.createRun({
      objective: 'collaboration completion guard',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: COORDINATOR_PANE
    })
    const producer = db.createTask({ spec: 'producer', runId: run.id })
    const subscriber = db.createTask({ spec: 'subscriber', runId: run.id })
    const dispatch = db.createDispatchContext(producer.id, 'term_producer', PRODUCER_PANE)
    registerCollaborationRuntimeTopology(
      runtime,
      run.id,
      createCollaborationTopology([
        { taskId: producer.id, publishesTo: ['/required'], requiredPublishesTo: ['/required'] },
        {
          taskId: subscriber.id,
          subscribesTo: ['/required'],
          admission: { acceptedTypes: ['result'], minPriority: 'normal' }
        }
      ])
    )
    return {
      db,
      runtime,
      runId: run.id,
      producerTaskId: producer.id,
      subscriberTaskId: subscriber.id,
      dispatchId: dispatch.id
    }
  }

  afterEach(() => {
    vi.restoreAllMocks()
    db?.close()
    db = undefined
    runtime = undefined
  })

  async function sendWorkerDone(
    fixture: Fixture,
    outcome: 'succeeded' | 'failed'
  ): Promise<{ lifecycle: { action: string; code?: string } }> {
    const method = ORCHESTRATION_METHODS.find((m) => m.name === 'orchestration.send')!
    const params = method.params!.parse({
      from: 'term_producer',
      subject: 'Done',
      type: 'worker_done',
      payload: JSON.stringify({
        taskId: fixture.producerTaskId,
        dispatchId: fixture.dispatchId,
        outcome
      })
    })
    return (await method.handler(params, { runtime: fixture.runtime } as RpcContext)) as {
      lifecycle: { action: string; code?: string }
    }
  }

  it('rejects a succeeded worker_done while a required collaboration publish is missing', async () => {
    const fixture = setup()

    const result = await sendWorkerDone(fixture, 'succeeded')

    expect(result.lifecycle).toMatchObject({
      action: 'rejected',
      code: 'collaboration_publish_incomplete'
    })
    expect(fixture.db.getTask(fixture.producerTaskId)?.status).toBe('dispatched')
    expect(fixture.db.getDispatchContextById(fixture.dispatchId)?.status).toBe('dispatched')
  })

  it('completes a succeeded worker_done once the required collaboration publish exists', async () => {
    const fixture = setup()
    publishCollaborationMessage(fixture.db, {
      runId: fixture.runId,
      publicationId: 'publication-required-1',
      producerTaskId: fixture.producerTaskId,
      subscriberTaskIds: [fixture.subscriberTaskId],
      topic: '/required',
      semanticType: 'result',
      priority: 'normal',
      body: 'required payload'
    })

    const result = await sendWorkerDone(fixture, 'succeeded')

    expect(result.lifecycle).toMatchObject({ action: 'completed' })
    expect(fixture.db.getTask(fixture.producerTaskId)?.status).toBe('completed')
    expect(fixture.db.getDispatchContextById(fixture.dispatchId)?.status).toBe('completed')
  })

  it('does not block a failed worker_done when the required collaboration publish is missing', async () => {
    const fixture = setup()

    const result = await sendWorkerDone(fixture, 'failed')

    expect(result.lifecycle).toMatchObject({ action: 'failed' })
    expect(fixture.db.getTask(fixture.producerTaskId)?.status).toBe('failed')
    expect(fixture.db.getDispatchContextById(fixture.dispatchId)?.status).toBe('failed')
  })
})
