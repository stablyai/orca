import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PipelineStore } from './pipeline-store'

const roots: string[] = []
const stores: PipelineStore[] = []
afterEach(() => {
  stores.splice(0).forEach((store) => store.close())
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
})

function open(file = ':memory:') {
  const store = new PipelineStore(file)
  stores.push(store)
  return store
}

const creation = {
  requestId: 'create-example',
  workspace: {
    id: 'repo::/project/task',
    instanceId: 'instance-1',
    hostId: 'local',
    projectId: 'project-1',
    path: '/project/task'
  },
  profile: {
    id: 'example/standard',
    version: '1',
    title: 'Standard development',
    roles: { primary: { agent: 'codex' }, reviewer: { agent: 'claude' } },
    checks: ['unit'],
    maxFixCycles: 2
  },
  task: 'Fix duplicate notification; preserve delivery receipts.'
}

describe('pipeline durable execution', () => {
  it('records an active worker result while paused and resumes the next stage', () => {
    const store = open()
    let run = store.create(creation)
    run = store.command(run.id, {
      requestId: 'start',
      expectedRevision: 0,
      command: { kind: 'dispatch', dispatchId: 'd', sessionId: 'main' }
    })
    const inputRevision = run.active!.inputRevision
    run = store.command(run.id, {
      requestId: 'pause',
      expectedRevision: run.revision,
      command: { kind: 'pause' }
    })
    run = store.command(run.id, {
      requestId: 'settle',
      expectedRevision: run.revision,
      command: {
        kind: 'submit',
        dispatchId: 'd',
        inputRevision,
        sourceRevision: 'a'.repeat(40),
        body: 'Plan evidence',
        verdict: 'pass'
      }
    })
    expect(run.state).toBe('paused')
    expect(run.stage).toBe('implement')
    run = store.command(run.id, {
      requestId: 'resume',
      expectedRevision: run.revision,
      command: { kind: 'resume' }
    })
    expect(run.state).toBe('running')
  })
  it('accepts a full cycle only after independent review and preserves evidence', () => {
    const store = open()
    let run = store.create(creation)
    for (const stage of ['plan', 'implement', 'checks', 'docs', 'review']) {
      run = store.command(run.id, {
        requestId: `dispatch-${stage}`,
        expectedRevision: run.revision,
        command: {
          kind: 'dispatch',
          dispatchId: `dispatch-${stage}`,
          sessionId: stage === 'review' ? 'review-session' : 'primary-session'
        }
      })
      run = store.command(run.id, {
        requestId: `submit-${stage}`,
        expectedRevision: run.revision,
        command: {
          kind: 'submit',
          dispatchId: `dispatch-${stage}`,
          inputRevision: run.active!.inputRevision,
          sourceRevision: 'a'.repeat(40),
          body: `${stage}: evidence`,
          verdict: 'pass'
        }
      })
    }
    expect(run.state).toBe('ready_for_review')
    run = store.command(run.id, {
      requestId: 'revalidate-new-source',
      expectedRevision: run.revision,
      command: { kind: 'revalidate' }
    })
    expect(run).toMatchObject({
      state: 'running',
      stage: 'checks',
      afterChecks: 'docs',
      fixCycles: 0
    })
    expect(run.checkedRevision).toBeUndefined()
    expect(store.pending().map((pending) => pending.id)).toContain(run.id)
    expect(store.context(run.id, 'review').artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage: 'checks',
          sourceRevision: 'a'.repeat(40),
          verdict: 'pass'
        }),
        expect.objectContaining({ stage: 'docs', body: 'docs: evidence' })
      ])
    )
    expect(
      store.context(run.id, 'review').artifacts.some((artifact) => artifact.stage === 'review')
    ).toBe(false)
  })

  it('replays the same request while refusing changed payload and stale transitions', () => {
    const store = open()
    const run = store.create(creation)
    expect(store.create(creation).id).toBe(run.id)
    expect(() => store.create({ ...creation, task: 'Another objective' })).toThrow(
      'pipeline_request_conflict'
    )
    const request = {
      requestId: 'dispatch',
      expectedRevision: run.revision,
      command: { kind: 'dispatch' as const, dispatchId: 'd1', sessionId: 'main' }
    }
    const next = store.command(run.id, request)
    expect(store.command(run.id, request).revision).toBe(next.revision)
    expect(() => store.command(run.id, { ...request, requestId: 'other' })).toThrow(
      'pipeline_revision_conflict'
    )
    expect(() =>
      store.command(run.id, { ...request, command: { ...request.command, dispatchId: 'd2' } })
    ).toThrow('pipeline_request_conflict')
  })

  it('refuses unbound submissions and review in the primary session', () => {
    const store = open()
    let run = store.create(creation)
    expect(() =>
      store.command(run.id, {
        requestId: 'stale',
        expectedRevision: 0,
        command: {
          kind: 'submit',
          dispatchId: 'old',
          inputRevision: 0,
          sourceRevision: 'a'.repeat(40),
          body: 'Plan',
          verdict: 'pass'
        }
      })
    ).toThrow('pipeline_dispatch_conflict')
    for (const stage of ['plan', 'implement', 'checks', 'docs']) {
      run = store.command(run.id, {
        requestId: `d-${stage}`,
        expectedRevision: run.revision,
        command: { kind: 'dispatch', dispatchId: stage, sessionId: 'main' }
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
          verdict: 'pass'
        }
      })
    }
    expect(() =>
      store.command(run.id, {
        requestId: 'bad-review',
        expectedRevision: run.revision,
        command: { kind: 'dispatch', dispatchId: 'review', sessionId: 'main' }
      })
    ).toThrow('pipeline_review_not_independent')
  })

  it('returns to checks if documentation changed the verified source', () => {
    const store = open()
    let run = store.create(creation)
    for (const stage of ['plan', 'implement', 'checks', 'docs']) {
      run = store.command(run.id, {
        requestId: `d-${stage}`,
        expectedRevision: run.revision,
        command: { kind: 'dispatch', dispatchId: stage, sessionId: 'main' }
      })
      run = store.command(run.id, {
        requestId: `s-${stage}`,
        expectedRevision: run.revision,
        command: {
          kind: 'submit',
          dispatchId: stage,
          inputRevision: run.active!.inputRevision,
          sourceRevision: (stage === 'docs' ? 'b' : 'a').repeat(40),
          body: 'Evidence',
          verdict: 'pass'
        }
      })
    }
    expect(run.stage).toBe('checks')
    expect(run.state).toBe('running')
  })

  it('retains two fix cycles across reopen and stops after the third rejection', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-pipeline-'))
    roots.push(root)
    const file = join(root, 'runs.sqlite')
    let store = open(file)
    let run = store.create(creation)
    let counter = 0
    while (run.state === 'running') {
      const stage = run.stage
      run = store.command(run.id, {
        requestId: `d-${counter}`,
        expectedRevision: run.revision,
        command: {
          kind: 'dispatch',
          dispatchId: `d-${counter}`,
          sessionId: stage === 'review' ? `review-${counter}` : 'main'
        }
      })
      run = store.command(run.id, {
        requestId: `s-${counter++}`,
        expectedRevision: run.revision,
        command: {
          kind: 'submit',
          dispatchId: run.active!.dispatchId,
          inputRevision: run.active!.inputRevision,
          sourceRevision: 'a'.repeat(40),
          body: 'Evidence',
          verdict: stage === 'review' ? 'changes_requested' : 'pass'
        }
      })
      if (run.stage === 'fix' && run.fixCycles === 1) {
        store.close()
        stores.splice(stores.indexOf(store), 1)
        store = open(file)
        run = store.get(run.id)
      }
    }
    expect(run.fixCycles).toBe(2)
    expect(run.state).toBe('failed')
  })

  it('keeps unknown dispatches stopped for reconciliation and rejects shell-like extra fields', () => {
    const store = open()
    let run = store.create(creation)
    run = store.command(run.id, {
      requestId: 'unknown',
      expectedRevision: run.revision,
      command: { kind: 'uncertain', reason: 'Launch receipt lost' }
    })
    expect(run.state).toBe('reconciliation_required')
    expect(() =>
      store.command(run.id, {
        requestId: 'blind-retry',
        expectedRevision: run.revision,
        command: { kind: 'dispatch', dispatchId: 'duplicate', sessionId: 'main' }
      })
    ).toThrow('pipeline_not_running')
    expect(() => store.create({ ...creation, requestId: 'unsafe', command: 'rm -rf /' })).toThrow()
  })
})

it('keeps setup as a durable gate and preserves an owner pause when setup completes', () => {
  const store = open()
  let run = store.create({ ...creation, waitForSetup: true })
  expect(run.state).toBe('waiting_setup')
  expect(() =>
    store.command(run.id, {
      requestId: 'early',
      expectedRevision: run.revision,
      command: { kind: 'dispatch', dispatchId: 'd', sessionId: 'main' }
    })
  ).toThrow('pipeline_not_running')
  run = store.command(run.id, {
    requestId: 'pause',
    expectedRevision: run.revision,
    command: { kind: 'pause' }
  })
  expect(() =>
    store.command(run.id, {
      requestId: 'resume',
      expectedRevision: run.revision,
      command: { kind: 'resume' }
    })
  ).toThrow('pipeline_reconciliation_required')
  run = store.command(run.id, {
    requestId: 'setup-done',
    expectedRevision: run.revision,
    command: { kind: 'setup_ready' }
  })
  expect(run.state).toBe('paused')
  expect(run.setupHold).toBeUndefined()
  run = store.command(run.id, {
    requestId: 'owner-resume',
    expectedRevision: run.revision,
    command: { kind: 'resume' }
  })
  expect(run.state).toBe('running')
})

it('retains ambiguous worktree creation reservations and returns a bound run on replay', () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-pipeline-create-'))
  roots.push(root)
  const file = join(root, 'runs.sqlite')
  let store = open(file)
  expect(store.reserveCreation('create', { name: 'task' })).toEqual({ fresh: true })
  store.close()
  stores.splice(stores.indexOf(store), 1)
  store = open(file)
  expect(store.reserveCreation('create', { name: 'task' })).toEqual({ fresh: false })
  expect(() => store.reserveCreation('create', { name: 'another' })).toThrow(
    'pipeline_request_conflict'
  )
  const run = store.create(creation)
  store.completeCreation('create', run.id)
  expect(store.reserveCreation('create', { name: 'task' })).toEqual({ fresh: false, run })
})
