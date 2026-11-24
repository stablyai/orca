import { afterEach, expect, it } from 'vitest'
import { stageEvidence } from './pipeline-evidence.test-fixture'
import { PipelineStore } from './pipeline-store'
import { PipelineController, type PipelinePorts } from './pipeline-controller'

const stores: PipelineStore[] = []
afterEach(() => stores.splice(0).forEach((store) => store.close()))

function fixture(start: PipelinePorts['start']) {
  const store = new PipelineStore(':memory:')
  stores.push(store)
  const run = store.create({
    requestId: 'create',
    task: 'Fix duplicate delivery',
    workspace: {
      id: 'repo::task',
      instanceId: 'instance',
      projectId: 'project',
      hostId: 'local',
      path: '/project/task'
    },
    profile: {
      id: 'example/standard',
      version: '1',
      title: 'Development',
      checks: ['unit'],
      maxFixCycles: 2,
      roles: { primary: { agent: 'codex' }, reviewer: { agent: 'claude' } }
    }
  })
  const ports: PipelinePorts = {
    start,
    reviewCommit: async () => 'c'.repeat(40),
    settled: async () => true,
    sourceRevision: async () => 'a'.repeat(40),
    checks: async () => ({ passed: true, body: 'unit: exit 0' })
  }
  return { store, run, controller: new PipelineController(store, ports) }
}

it('commits a single stage launch intent before external work and binds before task delivery', async () => {
  let resolveStart: (() => void) | undefined
  const gate = new Promise<void>((resolve) => {
    resolveStart = resolve
  })
  const delivered: string[] = []
  const { store, run, controller } = fixture(async (current, _spec, prepared) => {
    prepared({ dispatchId: 'd1', sessionId: 'main' })
    delivered.push(store.get(current.id).active!.dispatchId)
    await gate
    return { state: 'ready', dispatchId: 'd1', sessionId: 'main' }
  })
  const first = controller.advance(run.id)
  const second = controller.advance(run.id)
  resolveStart!()
  await Promise.all([first, second])
  expect(delivered).toEqual(['d1'])
})

it('executes checks again after documentation edits, uses a fresh review and returns review findings to the primary fix stage', async () => {
  const store = new PipelineStore(':memory:')
  stores.push(store)
  let source = 'a'.repeat(40)
  let counter = 0
  const launches: string[] = []
  const checks: string[] = []
  const settled = new Set<string>()
  const ports: PipelinePorts = {
    start: async (current, _spec, prepared) => {
      const dispatchId = `d-${counter++}`
      const sessionId = current.stage === 'review' ? `review-${counter}` : 'primary'
      launches.push(`${current.stage}:${sessionId}`)
      prepared({ dispatchId, sessionId })
      return { state: 'ready', dispatchId, sessionId }
    },
    settled: async (id) => settled.has(id),
    sourceRevision: async () => source,
    reviewCommit: async () => 'c'.repeat(40),
    checks: async () => {
      checks.push(source)
      return { passed: true, body: 'test: exit 0' }
    }
  }
  let controller = new PipelineController(store, ports)
  let run = store.create({
    requestId: 'full',
    task: 'Fix duplicate delivery',
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
      checks: ['test'],
      maxFixCycles: 2,
      roles: { primary: { agent: 'codex' }, reviewer: { agent: 'codex' } }
    }
  })
  let rejected = false
  let documented = false
  while (run.state === 'running') {
    await controller.advance(run.id)
    run = store.get(run.id)
    if (!run.active) {
      continue
    }
    if (run.stage === 'docs' && !documented) {
      source = 'b'.repeat(40)
      documented = true
    }
    const verdict = run.stage === 'review' && !rejected ? 'changes_requested' : 'pass'
    if (verdict === 'changes_requested') {
      rejected = true
    }
    if (run.stage === 'fix') {
      expect(store.context(run.id, 'fix').artifacts[0].body).toBe('Missing duplicate regression')
    }
    const dispatchId = run.active.dispatchId
    run = await controller.submit(
      run.id,
      {
        requestId: `s-${counter}`,
        expectedRevision: run.revision,
        command: {
          kind: 'submit',
          dispatchId,
          inputRevision: run.active.inputRevision,
          sourceRevision: source,
          evidence: stageEvidence(run.stage, verdict),
          body: verdict === 'changes_requested' ? 'Missing duplicate regression' : 'Evidence',
          verdict
        }
      },
      dispatchId
    )
    settled.add(dispatchId)
    controller = new PipelineController(store, ports)
  }
  expect(run.state).toBe('ready_for_review')
  expect(run.fixCycles).toBe(1)
  expect(launches).toEqual([
    'plan:primary',
    'implement:primary',
    'docs:primary',
    'review:review-4',
    'fix:primary',
    'docs:primary',
    'review:review-7'
  ])
  expect(checks).toEqual(['a'.repeat(40), 'b'.repeat(40), 'b'.repeat(40)])
})

it('does not repeat an unknown launch after recreating the controller', async () => {
  const launched: string[] = []
  const { store, run, controller } = fixture(async (current) => {
    launched.push(current.id)
    throw new Error('Connection lost after launch')
  })
  await controller.advance(run.id)
  const restored = new PipelineController(store, {
    reviewCommit: async () => 'c'.repeat(40),
    start: async () => {
      throw new Error('duplicate launch')
    },
    settled: async () => false,
    sourceRevision: async () => 'a'.repeat(40),
    checks: async () => ({ passed: true, body: 'unit: exit 0' })
  })
  await restored.advance(run.id)
  expect(store.get(run.id).state).toBe('reconciliation_required')
  expect(launched).toEqual([run.id])
})

it('rejects a source revision supplied by an agent instead of accepting stale evidence', async () => {
  const { store, run, controller } = fixture(async (_run, _spec, prepared) => {
    prepared({ dispatchId: 'd', sessionId: 'main' })
    return { state: 'ready', dispatchId: 'd', sessionId: 'main' }
  })
  await controller.advance(run.id)
  const active = store.get(run.id)
  await expect(
    controller.submit(
      run.id,
      {
        requestId: 'submit',
        expectedRevision: active.revision,
        command: {
          kind: 'submit',
          dispatchId: 'd',
          inputRevision: active.active!.inputRevision,
          sourceRevision: 'b'.repeat(40),
          evidence: stageEvidence('plan'),
          body: 'Plan',
          verdict: 'pass'
        }
      },
      'd'
    )
  ).rejects.toThrow('pipeline_source_changed')
  expect(store.get(run.id).stage).toBe('plan')
})

it('stops for owner recovery when a settled worker did not submit its stage', async () => {
  const { store, run, controller } = fixture(async (_run, _spec, prepared) => {
    prepared({ dispatchId: 'd', sessionId: 'main' })
    return { state: 'ready', dispatchId: 'd', sessionId: 'main' }
  })
  await controller.advance(run.id)
  await controller.advance(run.id)
  expect(store.get(run.id).state).toBe('waiting_owner')
  expect(store.get(run.id).active).toBeUndefined()
  expect(store.get(run.id).stage).toBe('plan')
})

it('replays an accepted submission after the source changes without applying it twice', async () => {
  const { store, run, controller } = fixture(async (_run, _spec, prepared) => {
    prepared({ dispatchId: 'd', sessionId: 'main' })
    return { state: 'ready', dispatchId: 'd', sessionId: 'main' }
  })
  await controller.advance(run.id)
  const current = store.get(run.id)
  const request = {
    requestId: 'result',
    expectedRevision: current.revision,
    command: {
      kind: 'submit',
      dispatchId: 'd',
      inputRevision: current.active!.inputRevision,
      sourceRevision: 'a'.repeat(40),
      evidence: stageEvidence('plan'),
      body: 'Plan',
      verdict: 'pass'
    }
  }
  const accepted = await controller.submit(run.id, request, 'd')
  expect(await controller.submit(run.id, request, 'd')).toEqual(accepted)
  expect(store.get(run.id).artifacts).toHaveLength(1)
})
