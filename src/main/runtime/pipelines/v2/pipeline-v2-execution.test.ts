import { afterEach, expect, it } from 'vitest'
import { PipelineStore } from '../pipeline-store'
import { PipelineController, type PipelinePorts } from '../pipeline-controller'
import { advancePipelineV2, type PipelineV2Ports } from './pipeline-v2-execution'
import {
  pipelineV2ReviewedFixture,
  pipelineV2TemplateFixture
} from '../../../../shared/pipelines/v2/pipeline-v2.test-fixture'
import {
  fixtureSession,
  fixtureSource,
  pipelineV2AdmissionFixture,
  settleV2Stage,
  v2Mutation
} from './pipeline-v2.test-fixture'

const stores: PipelineStore[] = []
afterEach(() => stores.splice(0).forEach((store) => store.close()))
function create() {
  const store = new PipelineStore(':memory:')
  stores.push(store)
  return store
}
function ports(): PipelineV2Ports {
  return {
    sourceRevision: async () => fixtureSource,
    reviewCommit: async () => 'b'.repeat(40),
    settled: async () => false,
    checks: async () => ({
      category: 'passed',
      body: 'unit passed',
      results: [{ id: 'unit', code: 0, timedOut: false, outputTruncated: false }]
    }),
    startInvocation: async (_request, _spec, prepared) => {
      prepared({ dispatchId: 'native-dispatch', session: fixtureSession })
      return { state: 'ready' }
    }
  }
}
it('does_not_send_task_data_to_a_stage_that_excludes_task_input', async () => {
  const store = create()
  const template = pipelineV2TemplateFixture()
  template.stages[0].inputs.task = false
  const admission = pipelineV2AdmissionFixture(template)
  admission.task = 'PRIVATE_TASK_INPUT'
  store.createV2(admission)
  const native = ports()
  let delivered = ''
  native.startInvocation = async (_request, spec, prepared) => {
    delivered = spec
    prepared({ dispatchId: 'native-dispatch', session: fixtureSession })
    return { state: 'ready' }
  }
  await advancePipelineV2(store, native, 'run-1')
  expect(delivered).toContain('Perform plan')
  expect(delivered).not.toContain('PRIVATE_TASK_INPUT')
})
it('rejects_a_result_when_summary_and_evidence_together_exceed_the_result_budget', async () => {
  const store = create()
  store.createV2(pipelineV2AdmissionFixture())
  await advancePipelineV2(store, ports(), 'run-1')
  const invocation = store.getV2('run-1').invocations[0]
  expect(() =>
    v2Mutation(store, {
      kind: 'submit',
      invocationId: invocation.id,
      dispatchId: invocation.dispatchId,
      inputRevision: invocation.inputRevision,
      sourceRevision: fixtureSource,
      result: {
        status: 'result',
        outcomeId: 'done',
        summary: 's'.repeat(11900),
        evidence: {
          stage: 'generic',
          statement: 'Result available',
          rationale: 'r'.repeat(1000),
          files: []
        }
      }
    })
  ).toThrow('pipeline_result_budget')
})
it('checks the exact published version again before dispatch after asynchronous preparation', async () => {
  const store = create()
  store.createV2(pipelineV2AdmissionFixture())
  let enabled = true
  const native = {
    ...ports(),
    definitionEnabled: () => enabled,
    sourceRevision: async () => {
      enabled = false
      return fixtureSource
    }
  }
  await advancePipelineV2(store, native, 'run-1')
  expect(store.getV2('run-1')).toMatchObject({ state: 'paused', definitionEnabled: false })
  expect(store.getV2('run-1').invocations.some((value) => value.dispatchId)).toBe(false)
})

it('persists the native session binding before waiting for a worker result', async () => {
  const store = create()
  store.createV2(pipelineV2AdmissionFixture())
  await advancePipelineV2(store, ports(), 'run-1')
  const run = store.getV2('run-1')
  expect(run.activeInvocationId).toBe('run-1:invocation:1')
  expect(run.invocations[0]).toMatchObject({
    state: 'running',
    dispatchId: 'native-dispatch',
    session: { sessionId: 'primary-session' }
  })
  expect(run.candidates).toEqual([])
})

it('routes mixed check results to failure even when their transport calls them passed', async () => {
  const store = create()
  const template = pipelineV2ReviewedFixture()
  const checks = template.stages[2]
  if (checks.kind !== 'checks') {
    throw new Error('Expected checks fixture')
  }
  checks.executor.checkIds = ['unit', 'lint']
  store.createV2(pipelineV2AdmissionFixture(template))
  settleV2Stage(store)
  settleV2Stage(store)
  const native = ports()
  native.checks = async () => ({
    category: 'passed',
    body: 'unit: 0; lint: 1',
    results: [
      { id: 'unit', code: 0, timedOut: false, outputTruncated: false },
      { id: 'lint', code: 1, timedOut: false, outputTruncated: false }
    ]
  })
  await advancePipelineV2(store, native, 'run-1')
  const run = store.getV2('run-1')
  expect(run).toMatchObject({ state: 'running', stageId: 'implement', usedInvocations: 3 })
  expect(run.candidates.at(-1)?.result).toMatchObject({ status: 'result', outcomeId: 'red' })
})

it('stops a settled worker without evidence instead of retrying it', async () => {
  const store = create()
  store.createV2(pipelineV2AdmissionFixture())
  const native = ports()
  await advancePipelineV2(store, native, 'run-1')
  native.settled = async () => true
  await advancePipelineV2(store, native, 'run-1')
  const run = store.getV2('run-1')
  expect(run).toMatchObject({
    state: 'waiting_owner',
    waitReason: 'interrupted',
    usedInvocations: 1
  })
  expect(run.activeInvocationId).toBeUndefined()
  expect(run.candidates).toEqual([])
})

it('uses the existing controller lock for two concurrent requests to advance the same v2 run', async () => {
  const store = create()
  store.createV2(pipelineV2AdmissionFixture())
  const native = ports()
  const legacy: PipelinePorts = {
    sourceRevision: native.sourceRevision,
    reviewCommit: native.reviewCommit,
    settled: native.settled,
    checks: async () => {
      throw new Error('Unexpected legacy checks')
    },
    start: async () => {
      throw new Error('Unexpected legacy launch')
    }
  }
  const controller = new PipelineController(store, legacy, native)
  await Promise.all([controller.advance('run-1'), controller.advance('run-1')])
  expect(store.getV2('run-1')).toMatchObject({
    state: 'running',
    activeInvocationId: 'run-1:invocation:1',
    usedInvocations: 1
  })
})

it('stops incomplete native check evidence without returning to implementation', async () => {
  const store = create()
  store.createV2(pipelineV2AdmissionFixture(pipelineV2ReviewedFixture()))
  settleV2Stage(store)
  settleV2Stage(store)
  const native = ports()
  native.checks = async () => ({ category: 'passed', body: 'No receipt', results: [] })
  await advancePipelineV2(store, native, 'run-1')
  expect(store.getV2('run-1')).toMatchObject({
    state: 'reconciliation_required',
    stageId: 'checks',
    usedInvocations: 3
  })
  expect(store.getV2('run-1').candidates.map((value) => value.summary)).toEqual([
    'plan result',
    'implement result'
  ])
})

it('treats a confirmed terminated timeout as a failed check', async () => {
  const store = create()
  store.createV2(pipelineV2AdmissionFixture(pipelineV2ReviewedFixture()))
  settleV2Stage(store)
  settleV2Stage(store)
  const native = ports()
  native.checks = async () => ({
    category: 'failed',
    body: 'unit timed out and stopped',
    results: [{ id: 'unit', code: null, timedOut: true, outputTruncated: false }]
  })
  await advancePipelineV2(store, native, 'run-1')
  expect(store.getV2('run-1')).toMatchObject({ state: 'running', stageId: 'implement' })
  expect(store.getV2('run-1').candidates.at(-1)?.result).toMatchObject({ outcomeId: 'red' })
})

it('does not accept checks when source changes while their process runs', async () => {
  const store = create()
  store.createV2(pipelineV2AdmissionFixture(pipelineV2ReviewedFixture()))
  settleV2Stage(store)
  settleV2Stage(store)
  const native = ports()
  native.checks = async () => {
    native.sourceRevision = async () => 'b'.repeat(64)
    return {
      category: 'passed',
      body: 'unit passed',
      results: [{ id: 'unit', code: 0, timedOut: false, outputTruncated: false }]
    }
  }
  await advancePipelineV2(store, native, 'run-1')
  expect(store.getV2('run-1')).toMatchObject({
    state: 'reconciliation_required',
    reason: 'pipeline_source_changed',
    stageId: 'checks'
  })
})

it('waits on invocation exhaustion without reserving another worker', async () => {
  const store = create()
  const admission = pipelineV2AdmissionFixture()
  admission.definition.limits.maxInvocations = 1
  // Recompile through a draft so the snapshot fingerprint still names these limits.
  const { digest: _digest, engineVersion: _engine, ...draft } = admission.definition
  const { compilePipelineV2 } = await import('../../../../shared/pipelines/v2/pipeline-v2-compiler')
  admission.definition = compilePipelineV2(draft)
  store.createV2(admission)
  settleV2Stage(store)
  await advancePipelineV2(store, ports(), 'run-1')
  expect(store.getV2('run-1')).toMatchObject({
    state: 'waiting_owner',
    waitReason: 'budget',
    usedInvocations: 1
  })
  expect(store.getV2('run-1').invocations.map((value) => value.id)).toEqual(['invocation-1'])
})
