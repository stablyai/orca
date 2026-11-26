import { afterEach, beforeEach, expect, it } from 'vitest'
import { PipelineStore } from '../pipeline-store'
import {
  gatedV2Template,
  pipelineV2AdmissionFixture,
  fixtureSource,
  v2Mutation
} from './pipeline-v2.test-fixture'
import { observePipelineV2RuntimeInput } from './pipeline-v2-runtime'
import { preparePipelineV2Input } from './pipeline-v2-input-events'

let store: PipelineStore
let release: () => void
const session = {
  kind: 'terminal' as const,
  sessionId: 'terminal-input-session',
  terminalHandle: 'terminal-input-handle',
  compatibilityKey: 'c'.repeat(64)
}
const runtime = { getRuntimeId: () => 'runtime-input-test' }
function submit(invocationId: string, summary: string) {
  const invocation = store.getV2('run-1').invocations.find((value) => value.id === invocationId)!
  v2Mutation(store, {
    kind: 'submit',
    invocationId,
    dispatchId: invocationId,
    inputRevision: invocation.inputRevision,
    sourceRevision: fixtureSource,
    result: {
      status: 'result',
      outcomeId: 'done',
      summary,
      evidence: {
        stage: 'generic',
        statement: summary,
        rationale: 'The stage assessed this turn',
        files: []
      }
    }
  })
}
beforeEach(() => {
  store = new PipelineStore(':memory:')
  const template = gatedV2Template()
  if (template.stages[0].kind !== 'agent') {
    throw new Error('Expected agent stage')
  }
  template.stages[0].executor.surface = 'terminal'
  const admission = pipelineV2AdmissionFixture(template)
  admission.effectiveExecutors.plan.surface = 'terminal'
  store.createV2(admission)
  v2Mutation(store, {
    kind: 'reserve',
    invocationId: 'initial',
    purpose: 'stage',
    sourceRevision: fixtureSource
  })
  v2Mutation(store, { kind: 'bind', invocationId: 'initial', dispatchId: 'initial', session })
  submit('initial', 'Initial plan')
  v2Mutation(store, { kind: 'settle', invocationId: 'initial' })
  release = observePipelineV2RuntimeInput(runtime, { store })
})
afterEach(() => {
  release()
  store.close()
})
const input = (data: string) =>
  preparePipelineV2Input(runtime, { handle: session.terminalHandle }, 'driving', data)
async function synchronize() {
  await input('Discuss rollback\r')
  const run = store.getV2('run-1')
  v2Mutation(store, {
    kind: 'reserve',
    invocationId: 'sync',
    purpose: 'synchronize',
    sourceRevision: fixtureSource,
    pin: run.pendingDecision,
    message: 'Assess the owner input'
  })
  v2Mutation(store, { kind: 'bind', invocationId: 'sync', dispatchId: 'sync', session })
}
it('finishes an attested synchronization despite bare Enter confirmations within its owned turn', async () => {
  await synchronize()
  await input('\r')
  submit('sync', 'Updated plan includes rollback')
  await input('\r')
  v2Mutation(store, { kind: 'settle', invocationId: 'sync' })
  const waiting = store.getV2('run-1')
  expect(waiting.unverifiedSessionInput).toBeUndefined()
  expect(waiting.waitReason).toBe('owner_gate')
  v2Mutation(store, { kind: 'decide', ...waiting.pendingDecision!, action: 'accept' })
  expect(store.getV2('run-1').stageId).toBe('implement')
})
it('keeps raw text typed during an owned turn unverified after its candidate settles', async () => {
  await synchronize()
  await input('Add a different requirement\r')
  submit('sync', 'Updated plan')
  await input('\r')
  v2Mutation(store, { kind: 'settle', invocationId: 'sync' })
  const waiting = store.getV2('run-1')
  expect(waiting.unverifiedSessionInput?.sessionId).toBe('terminal-input-session')
  expect(waiting.waitReason).toBe('session_sync')
  expect(() =>
    v2Mutation(store, { kind: 'decide', ...waiting.pendingDecision!, action: 'accept' })
  ).toThrow('pipeline_owner_decision_required')
})
it('does not treat bare Enter outside an owned turn as owner acceptance or synchronized input', async () => {
  await input('\r')
  const waiting = store.getV2('run-1')
  expect(waiting.waitReason).toBe('session_sync')
  expect(() =>
    v2Mutation(store, { kind: 'decide', ...waiting.pendingDecision!, action: 'accept' })
  ).toThrow('pipeline_owner_decision_required')
})
