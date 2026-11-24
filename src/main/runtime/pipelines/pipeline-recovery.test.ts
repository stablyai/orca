import { afterEach, expect, it } from 'vitest'
import { PipelineStore } from './pipeline-store'
import { PipelineController, type PipelinePorts } from './pipeline-controller'
import { stageEvidence } from './pipeline-evidence.test-fixture'

const stores: PipelineStore[] = []
afterEach(() => stores.splice(0).forEach((store) => store.close()))
function fixture(checks: PipelinePorts['checks']) {
  const store = new PipelineStore(':memory:')
  stores.push(store)
  let run = store.create({
    requestId: 'create',
    task: 'Fix delivery',
    workspace: {
      id: 'repo::task',
      instanceId: 'instance',
      projectId: 'repo',
      hostId: 'local',
      path: '/project/task'
    },
    profile: {
      id: 'standard',
      version: '1',
      title: 'Development',
      checks: ['unit'],
      maxFixCycles: 2,
      roles: { primary: { agent: 'codex' }, reviewer: { agent: 'codex' } }
    }
  })
  for (const stage of ['plan', 'implement'] as const) {
    run = store.command(run.id, {
      requestId: `d-${stage}`,
      expectedRevision: run.revision,
      command: { kind: 'dispatch', dispatchId: stage, sessionId: 'primary' }
    })
    run = store.command(run.id, {
      requestId: `s-${stage}`,
      expectedRevision: run.revision,
      command: {
        kind: 'submit',
        dispatchId: stage,
        inputRevision: run.active!.inputRevision,
        sourceRevision: 'a'.repeat(40),
        body: 'Evidence',
        evidence: stageEvidence(stage),
        verdict: 'pass'
      }
    })
  }
  const ports: PipelinePorts = {
    checks,
    settled: async () => true,
    sourceRevision: async () => 'a'.repeat(40),
    reviewCommit: async () => 'c'.repeat(40),
    start: async () => {
      throw new Error('Unexpected agent launch')
    }
  }
  return { store, run, ports, controller: new PipelineController(store, ports) }
}

it('treats incomplete checks as unknown, preserves the fix budget and reconciles a completed effect without restart', async () => {
  const { store, run, controller } = fixture(async () => ({
    passed: false,
    uncertain: true,
    body: 'unit: timeout',
    results: [{ id: 'unit', code: null, timedOut: true, outputTruncated: false }]
  }))
  await controller.advance(run.id)
  expect(store.get(run.id)).toMatchObject({
    state: 'reconciliation_required',
    stage: 'checks',
    fixCycles: 0
  })
  const recovered = await controller.reconcile(run.id)
  expect(recovered).toMatchObject({ state: 'waiting_owner', stage: 'checks', fixCycles: 0 })
  expect(recovered.active).toBeUndefined()
  expect(recovered.artifacts.map((artifact) => artifact.stage)).toEqual(['plan', 'implement'])
})

it('reconciles post-check source edits only after the running check transport settles', async () => {
  let signalStarted!: () => void
  const started = new Promise<void>((resolve) => {
    signalStarted = resolve
  })
  let finish!: () => void
  const gate = new Promise<void>((resolve) => {
    finish = resolve
  })
  const current = fixture(async () => {
    signalStarted()
    await gate
    current.ports.sourceRevision = async () => 'b'.repeat(40)
    return { passed: true, body: 'unit: exit 0' }
  })
  const running = current.controller.advance(current.run.id)
  await started
  expect((await current.controller.reconcile(current.run.id)).active?.sessionId).toBe(
    'runtime-checks'
  )
  finish()
  await running
  expect(current.store.get(current.run.id).state).toBe('reconciliation_required')
  expect((await current.controller.reconcile(current.run.id)).state).toBe('waiting_owner')
})

it('refuses missing docs rationale instead of accepting a free-text PASS', async () => {
  const { store, run, controller } = fixture(async () => ({ passed: true, body: 'unit: exit 0' }))
  await controller.advance(run.id)
  let current = store.get(run.id)
  current = store.command(run.id, {
    requestId: 'd-docs',
    expectedRevision: current.revision,
    command: { kind: 'dispatch', dispatchId: 'docs', sessionId: 'primary' }
  })
  await expect(
    controller.submit(
      run.id,
      {
        requestId: 'empty-docs',
        expectedRevision: current.revision,
        command: {
          kind: 'submit',
          dispatchId: 'docs',
          inputRevision: current.active!.inputRevision,
          sourceRevision: 'a'.repeat(40),
          body: 'x',
          evidence: { stage: 'docs', files: [] },
          verdict: 'pass'
        }
      },
      'docs'
    )
  ).rejects.toThrow()
  expect(store.get(run.id).stage).toBe('docs')
  expect(store.get(run.id).active?.dispatchId).toBe('docs')
})

it('refuses a plan without structured acceptance criteria', async () => {
  const { store, run, controller } = fixture(async () => ({ passed: true, body: 'unit: exit 0' }))
  const plan = store.create({
    requestId: 'another-task',
    task: 'Fix acceptance',
    profile: run.profile,
    workspace: { ...run.workspace, instanceId: 'another-instance' }
  })
  const active = store.command(plan.id, {
    requestId: 'bind-plan',
    expectedRevision: 0,
    command: { kind: 'dispatch', dispatchId: 'plan', sessionId: 'primary' }
  })
  await expect(
    controller.submit(
      plan.id,
      {
        requestId: 'empty-plan',
        expectedRevision: active.revision,
        command: {
          kind: 'submit',
          dispatchId: 'plan',
          inputRevision: active.active!.inputRevision,
          sourceRevision: 'a'.repeat(40),
          body: 'PASS',
          verdict: 'pass'
        }
      },
      'plan'
    )
  ).rejects.toThrow()
  expect(store.get(plan.id).stage).toBe('plan')
  expect(store.get(plan.id).active?.dispatchId).toBe('plan')
})
