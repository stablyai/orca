import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PipelineStore } from '../pipeline-store'
import { advancePipelineV2, type PipelineV2Ports } from './pipeline-v2-execution'
import {
  fixtureSession,
  fixtureSource,
  gatedV2Template,
  pipelineV2AdmissionFixture,
  v2Mutation
} from './pipeline-v2.test-fixture'
import type { PipelineV2Response } from './pipeline-v2-response'

const result = {
  status: 'result' as const,
  outcomeId: 'done',
  summary: 'Plan documented',
  evidence: {
    stage: 'generic' as const,
    statement: 'Plan available',
    rationale: 'Steps meet scope',
    files: []
  }
}
const directories: string[] = []
afterEach(() =>
  directories.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }))
)
async function setup(review = false) {
  const dir = mkdtempSync(join(tmpdir(), 'pipeline-response-'))
  directories.push(dir)
  const path = join(dir, 'pipelines.db')
  let store = new PipelineStore(path)
  const template = gatedV2Template()
  if (review) {
    const stage = template.stages[0]
    if (stage.kind !== 'agent') {
      throw new Error('Expected agent stage')
    }
    stage.evidenceSchema = 'review'
    stage.independent = true
    stage.executor.session = { kind: 'fresh' }
  }
  store.createV2(pipelineV2AdmissionFixture(template))
  let observed: PipelineV2Response = { state: 'pending' }
  const settlements: string[] = []
  const ports: PipelineV2Ports = {
    sourceRevision: async () => fixtureSource,
    reviewCommit: async () => 'b'.repeat(40),
    settled: async () => false,
    response: async () => observed,
    completeResponse: async (_invocation, candidate) => {
      settlements.push(candidate ? 'delivered' : 'failed')
    },
    checks: async () => {
      throw new Error('Unexpected check')
    },
    startInvocation: async (_request, _spec, prepared) => {
      prepared({ dispatchId: 'native-dispatch', session: fixtureSession })
      return {
        state: 'ready',
        dispatchId: 'native-dispatch',
        session: fixtureSession,
        responseMessageId: 'message-1'
      }
    }
  }
  await advancePipelineV2(store, ports, 'run-1')
  return {
    get store() {
      return store
    },
    ports,
    settlements,
    response: (next: PipelineV2Response) => {
      observed = next
    },
    reopen: () => {
      store.close()
      store = new PipelineStore(path)
    }
  }
}
it('collects a completed response without worker_done and preserves the owner decision gate', async () => {
  const h = await setup()
  try {
    await advancePipelineV2(h.store, h.ports, 'run-1')
    expect(h.store.getV2('run-1').candidates).toEqual([])
    h.response({ state: 'completed', result })
    await advancePipelineV2(h.store, h.ports, 'run-1')
    const run = h.store.getV2('run-1')
    expect(run).toMatchObject({
      state: 'waiting_owner',
      waitReason: 'owner_gate',
      usedInvocations: 1
    })
    expect(run.pendingDecision?.proposedOutcomeId).toBe('done')
    expect(run.candidates.map((candidate) => candidate.summary)).toEqual(['Plan documented'])
    expect(h.settlements).toEqual(['delivered'])
  } finally {
    h.store.close()
  }
})
it.each(['interrupted', 'unverifiable'] as const)(
  'does not advance a %s response',
  async (state) => {
    const h = await setup()
    try {
      h.response({ state })
      await advancePipelineV2(h.store, h.ports, 'run-1')
      const run = h.store.getV2('run-1')
      expect(run.state).toBe(state === 'interrupted' ? 'waiting_owner' : 'reconciliation_required')
      expect(run.usedInvocations).toBe(1)
      expect(run.candidates).toEqual([])
      expect(h.settlements).toEqual(state === 'interrupted' ? ['failed'] : [])
    } finally {
      h.store.close()
    }
  }
)
it('rejects a schema-valid result for an outcome outside the stage contract', async () => {
  const h = await setup()
  try {
    h.response({ state: 'completed', result: { ...result, outcomeId: 'invented' } })
    await advancePipelineV2(h.store, h.ports, 'run-1')
    expect(h.store.getV2('run-1')).toMatchObject({
      state: 'waiting_owner',
      waitReason: 'interrupted'
    })
    expect(h.store.getV2('run-1').candidates).toEqual([])
    expect(h.settlements).toEqual(['failed'])
  } finally {
    h.store.close()
  }
})
it('recovers the persisted candidate and message identity after a crash before Dispatch settlement', async () => {
  const h = await setup()
  try {
    const invocation = h.store.getV2('run-1').invocations[0]
    v2Mutation(
      h.store,
      {
        kind: 'submit',
        invocationId: invocation.id,
        dispatchId: invocation.dispatchId,
        inputRevision: invocation.inputRevision,
        sourceRevision: fixtureSource,
        result
      },
      `response:${invocation.id}`
    )
    h.reopen()
    h.response({ state: 'completed', result })
    await advancePipelineV2(h.store, h.ports, 'run-1')
    expect(h.store.getV2('run-1')).toMatchObject({
      state: 'waiting_owner',
      waitReason: 'owner_gate',
      usedInvocations: 1
    })
    expect(h.store.getV2('run-1').candidates).toHaveLength(1)
    expect(h.settlements).toEqual(['delivered'])
  } finally {
    h.store.close()
  }
})
it('keeps an explicitly blocked result out of the success route', async () => {
  const h = await setup()
  try {
    h.response({
      state: 'completed',
      result: {
        status: 'blocked',
        reason: 'Missing task input',
        summary: 'No implementation attempted'
      }
    })
    await advancePipelineV2(h.store, h.ports, 'run-1')
    expect(h.store.getV2('run-1')).toMatchObject({
      state: 'waiting_owner',
      waitReason: 'blocked',
      usedInvocations: 1
    })
    expect(h.store.getV2('run-1').pendingDecision).toBeUndefined()
  } finally {
    h.store.close()
  }
})
it('rechecks the independent review commit at automatic collection, not only launch', async () => {
  const h = await setup(true)
  try {
    h.response({
      state: 'completed',
      result: { ...result, evidence: { stage: 'review', findings: [] } }
    })
    h.ports.reviewCommit = async () => 'c'.repeat(40)
    await advancePipelineV2(h.store, h.ports, 'run-1')
    expect(h.store.getV2('run-1')).toMatchObject({
      state: 'reconciliation_required',
      reason: 'pipeline_source_changed'
    })
    expect(h.store.getV2('run-1').candidates).toEqual([])
    expect(h.settlements).toEqual([])
  } finally {
    h.store.close()
  }
})
it('holds a persisted response when source changes before recovery', async () => {
  const h = await setup()
  try {
    const invocation = h.store.getV2('run-1').invocations[0]
    v2Mutation(h.store, {
      kind: 'submit',
      invocationId: invocation.id,
      dispatchId: invocation.dispatchId,
      inputRevision: invocation.inputRevision,
      sourceRevision: fixtureSource,
      result
    })
    h.reopen()
    h.response({ state: 'completed', result })
    h.ports.sourceRevision = async () => 'd'.repeat(64)
    await advancePipelineV2(h.store, h.ports, 'run-1')
    expect(h.store.getV2('run-1').state).toBe('reconciliation_required')
    expect(h.settlements).toEqual([])
  } finally {
    h.store.close()
  }
})
