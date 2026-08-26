import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationDb } from '../../orchestration/db'
import { createCollaborationTopology } from '../../collaboration/collaboration-topology'
import { getCollaborationRuntimeTopology } from '../../collaboration/collaboration-runtime-registry'
import type { RpcContext } from '../core'
import { COLLABORATION_CONFIGURE_METHODS } from './collaboration-configure'

const COORD_PANE_KEY = 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

describe('orchestration.collaborationConfigure', () => {
  const method = COLLABORATION_CONFIGURE_METHODS[0]!

  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let runId: string
  let taskId: string

  function createTask(spec: string, forRunId = runId): string {
    return db.createTask({ spec, runId: forRunId }).id
  }

  function createOtherRun(): string {
    return db.createRun({
      objective: 'other run',
      coordinatorHandle: 'term_other',
      coordinatorPaneKey: 'tab_other:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    }).id
  }

  function setup(): void {
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_coord' ? COORD_PANE_KEY : null
    )
    runId = db.createRun({
      objective: 'collaboration configure',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: COORD_PANE_KEY
    }).id
    taskId = createTask('publisher')
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

  function configureParams(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      from: 'term_coord',
      steps: [{ taskId, publishesTo: ['feature-a'] }],
      ...overrides
    }
  }

  it('registers the topology for the coordinator bound run and reports step count', async () => {
    setup()

    const result = (await call(configureParams())) as { runId: string; stepCount: number }

    expect(result).toEqual({ runId, stepCount: 1 })
    expect(getCollaborationRuntimeTopology(runtime, runId)).toEqual(
      createCollaborationTopology([{ taskId, publishesTo: ['feature-a'] }])
    )
  })

  it('fences an explicit run that is not the coordinator current run', async () => {
    setup()
    const otherRunId = createOtherRun()

    await expect(call(configureParams({ run: otherRunId }))).rejects.toMatchObject({
      code: 'consumer_fenced'
    })
    expect(getCollaborationRuntimeTopology(runtime, runId)).toBeUndefined()
  })

  it('rejects a step whose task belongs to another run with no registry effect', async () => {
    setup()
    const otherRunId = createOtherRun()
    const foreignTaskId = createTask('foreign', otherRunId)

    await expect(
      call(configureParams({ steps: [{ taskId: foreignTaskId, publishesTo: ['feature-a'] }] }))
    ).rejects.toMatchObject({ code: 'task_not_found' })
    expect(getCollaborationRuntimeTopology(runtime, runId)).toBeUndefined()
  })

  it('rejects a second configuration for the same run', async () => {
    setup()
    await call(configureParams())

    await expect(
      call(configureParams({ steps: [{ taskId, publishesTo: ['feature-b'] }] }))
    ).rejects.toMatchObject({ code: 'collaboration_topology_exists' })
  })

  it('surfaces required-topic topology validation as invalid_argument', async () => {
    setup()

    await expect(
      call(
        configureParams({
          steps: [{ taskId, publishesTo: ['feature-a'], requiredPublishesTo: ['feature-a'] }]
        })
      )
    ).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(getCollaborationRuntimeTopology(runtime, runId)).toBeUndefined()
  })

  it('surfaces duplicate taskIds as invalid_argument', async () => {
    setup()

    await expect(
      call(
        configureParams({
          steps: [
            { taskId, publishesTo: ['feature-a'] },
            { taskId, publishesTo: ['feature-b'] }
          ]
        })
      )
    ).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(getCollaborationRuntimeTopology(runtime, runId)).toBeUndefined()
  })

  it('surfaces a subscription without admission policy as invalid_argument', async () => {
    setup()
    const subscriberTaskId = createTask('subscriber')

    await expect(
      call(
        configureParams({
          steps: [
            { taskId, publishesTo: ['feature-a'] },
            { taskId: subscriberTaskId, subscribesTo: ['feature-a'] }
          ]
        })
      )
    ).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(getCollaborationRuntimeTopology(runtime, runId)).toBeUndefined()
  })

  it('keeps the registered topology retrievable with derived topic routing', async () => {
    setup()
    const subscriberTaskId = createTask('subscriber')

    await call(
      configureParams({
        steps: [
          { taskId, publishesTo: ['feature-a'] },
          {
            taskId: subscriberTaskId,
            subscribesTo: ['feature-a'],
            admission: { acceptedTypes: ['status'], minPriority: 'normal' }
          }
        ]
      })
    )

    const topology = getCollaborationRuntimeTopology(runtime, runId)
    expect(topology).toBeDefined()
    expect(topology!.steps.map((step) => step.taskId)).toEqual([taskId, subscriberTaskId])
    expect(topology!.steps[1]!.admission).toEqual({
      acceptedTypes: ['status'],
      minPriority: 'normal'
    })
  })
})
