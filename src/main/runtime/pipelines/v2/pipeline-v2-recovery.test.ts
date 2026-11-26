import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import Database from '../../../sqlite/sync-database'
import { PipelineStore } from '../pipeline-store'
import { pipelineV2TemplateFixture } from '../../../../shared/pipelines/v2/pipeline-v2.test-fixture'
import {
  fixtureSource,
  pipelineV2AdmissionFixture,
  settleV2Stage,
  v2Mutation
} from './pipeline-v2.test-fixture'

const stores = new Set<PipelineStore>()
const roots: string[] = []
afterEach(() => {
  for (const store of stores) {
    store.close()
  }
  stores.clear()
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})
function open(path = ':memory:') {
  const store = new PipelineStore(path)
  stores.add(store)
  return store
}
function disk() {
  const root = mkdtempSync(join(tmpdir(), 'orca-v2-recovery-'))
  roots.push(root)
  return { root, path: join(root, 'runs.sqlite') }
}

it('retains separate visits and spent retry budget across reopen', () => {
  const { path } = disk()
  let store = open(path)
  const template = pipelineV2TemplateFixture()
  template.stages[0].maxReentries = 0
  store.createV2(pipelineV2AdmissionFixture(template))
  settleV2Stage(store)
  settleV2Stage(store)
  settleV2Stage(store, 'changes')
  store.close()
  stores.delete(store)
  store = open(path)
  const exhausted = store.getV2('run-1')
  expect(exhausted).toMatchObject({
    state: 'waiting_owner',
    waitReason: 'budget',
    usedInvocations: 3
  })
  expect(exhausted.visits.map((visit) => visit.id)).toEqual([
    'run-1:visit:1',
    'run-1:visit:2',
    'run-1:visit:3'
  ])
  expect(() => v2Mutation(store, { kind: 'resume' })).toThrow('pipeline_owner_decision_required')
  const extended = v2Mutation(store, { kind: 'extend_budget', stageId: 'plan', maxReentries: 1 })
  expect(extended).toMatchObject({ state: 'running', stageId: 'plan', usedInvocations: 3 })
  expect(extended.visits.at(-1)).toMatchObject({ id: 'run-1:visit:4', attempt: 1 })
})

it('keeps pending candidate pins and exact decision receipts across restart', () => {
  const { path } = disk()
  let store = open(path)
  const template = pipelineV2TemplateFixture()
  template.stages[0].ownerGate.enabled = true
  store.createV2(pipelineV2AdmissionFixture(template))
  const before = settleV2Stage(store)
  store.close()
  stores.delete(store)
  store = open(path)
  const after = store.getV2('run-1')
  expect(after.pendingDecision).toEqual(before.pendingDecision)
  v2Mutation(store, { kind: 'decide', action: 'accept', ...after.pendingDecision! }, 'accept-once')
  expect(store.receiptV2('run-1', 'accept-once')).toMatchObject({ kind: 'decide', runId: 'run-1' })
  expect(store.eventsV2('run-1', 0, 50).events.map((event) => event.kind)).toEqual([
    'create',
    'reserve',
    'bind',
    'submit',
    'settle',
    'decide'
  ])
})

it('does not expose new runs through legacy reads or allow a second engine on one instance', () => {
  const store = open()
  store.createV2(pipelineV2AdmissionFixture())
  expect(store.list()).toEqual([])
  expect(() =>
    store.create({
      requestId: 'legacy-create',
      task: 'Legacy work',
      workspace: pipelineV2AdmissionFixture().workspace,
      profile: {
        id: 'legacy',
        title: 'Legacy',
        version: '1',
        checks: ['unit'],
        maxFixCycles: 2,
        roles: { primary: { agent: 'codex' }, reviewer: { agent: 'claude' } }
      }
    })
  ).toThrow('pipeline_workspace_already_bound')
  expect(store.getV2('run-1').stageId).toBe('plan')
})

it('refuses unknown schema versions without changing their marker', () => {
  const { path } = disk()
  const initial = open(path)
  initial.close()
  stores.delete(initial)
  const db = new Database(path)
  db.prepare('UPDATE pipeline_schema SET version = 99 WHERE component = ?').run('pipelines-v2')
  db.close()
  chmodSync(path, 0o600)
  expect(() => new PipelineStore(path)).toThrow('pipeline_schema_unsupported')
  const read = new Database(path, { readonly: true })
  expect(
    read.prepare('SELECT version FROM pipeline_schema WHERE component = ?').get('pipelines-v2')
      ?.version
  ).toBe(99)
  read.close()
})

it('does not relaunch an invocation whose durable effect claim has no receipt', async () => {
  const { root, path } = disk()
  const store = open(path)
  store.createV2(pipelineV2AdmissionFixture())
  store.claimEffect('pipeline-v2:run-1:invocation:1')
  const { advancePipelineV2 } = await import('./pipeline-v2-execution')
  await advancePipelineV2(
    store,
    {
      sourceRevision: async () => fixtureSource,
      reviewCommit: async () => 'b'.repeat(40),
      settled: async () => false,
      checks: async () => ({ category: 'passed', body: 'unit passed', results: [] }),
      startInvocation: async () => {
        writeFileSync(join(root, 'unexpected-launch'), 'launched')
        throw new Error('Should never launch')
      }
    },
    'run-1'
  )
  expect(store.getV2('run-1').state).toBe('reconciliation_required')
  expect(existsSync(join(root, 'unexpected-launch'))).toBe(false)
})

it('does not let v2 reuse a run identity already owned by the legacy engine', () => {
  const store = open()
  const legacy = store.create({
    requestId: 'legacy',
    task: 'Legacy task',
    workspace: {
      ...pipelineV2AdmissionFixture().workspace,
      instanceId: 'legacy-instance'
    },
    profile: {
      id: 'legacy',
      title: 'Legacy',
      version: '1',
      checks: ['unit'],
      maxFixCycles: 2,
      roles: { primary: { agent: 'codex' }, reviewer: { agent: 'claude' } }
    }
  })
  expect(() => store.createV2({ ...pipelineV2AdmissionFixture(), id: legacy.id })).toThrow(
    'pipeline_run_identity_conflict'
  )
  expect(store.get(legacy.id).stage).toBe('plan')
})

it('applies the existing active-run bound across both engines', () => {
  const store = open()
  const admission = pipelineV2AdmissionFixture()
  for (let index = 0; index < 50; index++) {
    store.createV2({
      ...admission,
      id: `run-${index}`,
      requestId: `create-${index}`,
      workspace: { ...admission.workspace, instanceId: `instance-${index}` }
    })
  }
  expect(() =>
    store.create({
      requestId: 'legacy-overflow',
      task: 'Too many active runs',
      workspace: { ...admission.workspace, instanceId: 'overflow' },
      profile: {
        id: 'legacy',
        title: 'Legacy',
        version: '1',
        checks: ['unit'],
        maxFixCycles: 2,
        roles: { primary: { agent: 'codex' }, reviewer: { agent: 'claude' } }
      }
    })
  ).toThrow('pipeline_active_run_limit')
})
