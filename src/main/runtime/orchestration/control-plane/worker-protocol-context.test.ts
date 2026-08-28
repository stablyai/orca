import { describe, expect, it } from 'vitest'
import {
  buildWorkerProtocolContext,
  renderRetainedDispatchDelta,
  renderWorkerBootstrap
} from './worker-protocol-context'

function context(
  overrides: Partial<Parameters<typeof buildWorkerProtocolContext>[0]['identity']> = {}
) {
  return buildWorkerProtocolContext({
    identity: {
      taskId: 'task_1',
      dispatchId: 'ctx_1',
      runId: 'run_1',
      outcomeId: 'out_1',
      coordinatorHandle: 'term_coord',
      workerHandle: 'term_worker',
      dispatchCapability: 'dcap_secret',
      ...overrides
    },
    cli: 'orca'
  })
}

describe('B5 runtime-generated worker context', () => {
  it('binds Task, Dispatch, coordinator, capability and Run/outcome identity', () => {
    const bootstrap = renderWorkerBootstrap(context())
    expect(bootstrap).toContain('Task: task_1')
    expect(bootstrap).toContain('Dispatch: ctx_1')
    expect(bootstrap).toContain('Run: run_1')
    expect(bootstrap).toContain('Outcome: out_1')
    expect(bootstrap).toContain('Coordinator: term_coord')
    expect(bootstrap).toContain('--dispatch-capability dcap_secret')
  })

  it('exposes exactly the three typed operations, each fully bound', () => {
    const ctx = context()
    expect(Object.keys(ctx.operations).sort()).toEqual(['ask', 'escalate', 'report'])
    expect(ctx.operations.report.invocation).toContain(
      'orchestration report --from term_worker --task task_1 --dispatch ctx_1'
    )
    expect(ctx.operations.escalate.invocation).toContain(
      'orchestration escalate --from term_worker --task task_1 --dispatch ctx_1'
    )
    expect(ctx.operations.ask.invocation).toContain('orchestration ask --from term_worker')
  })

  it('never asks the model to assemble a raw send command line', () => {
    const bootstrap = renderWorkerBootstrap(context())
    expect(bootstrap).not.toContain('--type worker_done')
    expect(bootstrap).not.toContain('--type escalation')
    expect(bootstrap).not.toContain('--payload')
  })

  it('negative control: teaches no liveness cadence and no polling loop', () => {
    const bootstrap = renderWorkerBootstrap(context())
    expect(bootstrap).not.toMatch(/heartbeat/i)
    expect(bootstrap).not.toMatch(/every \d+ minutes/i)
    expect(bootstrap).toContain('You do not\nsend liveness signals')
  })

  it('omits Run and outcome lines when the runtime has none to bind', () => {
    const bootstrap = renderWorkerBootstrap(context({ runId: null, outcomeId: null }))
    expect(bootstrap).not.toContain('Run: ')
    expect(bootstrap).not.toContain('Outcome: ')
  })
})

describe('B5 retained re-engagement is a delta, not the manual again', () => {
  it('sends only the changed ids and the report operation', () => {
    const delta = renderRetainedDispatchDelta({
      context: context({ taskId: 'task_2', dispatchId: 'ctx_2' }),
      previous: { taskId: 'task_1', dispatchId: 'ctx_1' }
    })
    expect(delta).toContain('Task: task_1 -> task_2')
    expect(delta).toContain('Dispatch: ctx_1 -> ctx_2')
    expect(delta).toContain(
      'orchestration report --from term_worker --task task_2 --dispatch ctx_2'
    )
  })

  it('is materially smaller than the fresh bootstrap and repeats none of its rules', () => {
    const ctx = context({ taskId: 'task_2', dispatchId: 'ctx_2' })
    const bootstrap = renderWorkerBootstrap(ctx)
    const delta = renderRetainedDispatchDelta({
      context: ctx,
      previous: { taskId: 'task_1', dispatchId: 'ctx_1' }
    })
    expect(delta.length).toBeLessThan(bootstrap.length / 2)
    expect(delta).not.toContain('AskUserQuestion')
    expect(delta).not.toContain('=== OPERATIONS ===')
  })

  it('still reports the Dispatch change when the Task is unchanged', () => {
    const delta = renderRetainedDispatchDelta({
      context: context({ dispatchId: 'ctx_2' }),
      previous: { taskId: 'task_1', dispatchId: 'ctx_1' }
    })
    expect(delta).not.toContain('Task: task_1 ->')
    expect(delta).toContain('Dispatch: ctx_1 -> ctx_2')
  })
})
