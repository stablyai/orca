import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createPipelineV2RpcTestHarness } from './pipelines-v2.test-support'
import {
  gatedV2Template,
  fixtureSource,
  fixtureSession,
  v2Mutation
} from '../../../pipelines/v2/pipeline-v2.test-fixture'
const hostRef = vi.hoisted((): { current: unknown } => ({ current: null }))
vi.mock(
  '../../../../native-chat/agent-session-wire/host/structured-agent-session-registry',
  () => ({ getStructuredAgentSessionHost: () => hostRef.current })
)
let harness: ReturnType<typeof createPipelineV2RpcTestHarness>
beforeEach(() => {
  harness = createPipelineV2RpcTestHarness(hostRef)
})
afterEach(() => {
  harness.store.close()
  harness.h.close()
  vi.restoreAllMocks()
})
const scope = {
  id: 'run-1',
  projectId: 'project-1',
  expectedInstanceId: 'instance-1',
  expectedRuntimeId: 'runtime-v2'
}
const call = (method: string, params: unknown) =>
  harness.dispatcher.dispatch({ id: 'rpc-recovery', authToken: 'test', method, params })
it('recovers the exact ended Chat response after a source-read interruption without another invocation or automatic continuation', async () => {
  const { store, ports } = harness
  v2Mutation(store, {
    kind: 'reserve',
    invocationId: 'response-recovery',
    purpose: 'stage',
    sourceRevision: fixtureSource
  })
  v2Mutation(store, {
    kind: 'bind',
    invocationId: 'response-recovery',
    dispatchId: 'ended-dispatch',
    session: fixtureSession
  })
  store.claimEffect('pipeline-v2:response-recovery')
  store.settleEffect('pipeline-v2:response-recovery', {
    state: 'ready',
    dispatchId: 'ended-dispatch',
    session: fixtureSession,
    responseMessageId: 'message-1'
  })
  const result = {
    status: 'result' as const,
    outcomeId: 'done',
    summary: 'Plan complete',
    evidence: {
      stage: 'generic' as const,
      statement: 'Plan recorded',
      rationale: 'Scope covered',
      files: []
    }
  }
  const observation = {
    requestMessageId: 'message-1',
    clientMessageId: 'message-1',
    turnItemId: 'turn-1',
    responseItemId: 'answer-1',
    rawDigest: 'd'.repeat(64),
    rawResponse: JSON.stringify(result),
    category: 'result' as const
  }
  v2Mutation(store, {
    kind: 'observe_response',
    invocationId: 'response-recovery',
    observation: {
      ...observation,
      category: 'transport_unknown',
      reason: 'pipeline_source_unavailable'
    }
  })
  const unknown = v2Mutation(store, { kind: 'uncertain', reason: 'pipeline_source_unavailable' })
  ports.response = async () => ({ state: 'completed', result, observation })
  const reports: string[] = []
  ports.completeResponse = async (_invocation, candidate) => {
    reports.push(candidate?.summary ?? 'failed')
  }
  const request = {
    ...scope,
    requestId: 'recover-exact-response',
    expectedRevision: unknown.revision
  }
  expect(await call('pipeline.v2.reconcile', request)).toMatchObject({
    ok: true,
    result: {
      receipt: { kind: 'reconcile', inputRevision: unknown.revision },
      run: { state: 'paused', waitReason: 'owner_gate', usedInvocations: 1 }
    }
  })
  expect(store.getV2('run-1').candidates).toHaveLength(1)
  expect(store.getV2('run-1').invocations[0]).toMatchObject({
    state: 'settled',
    responseObservation: { category: 'result', turnItemId: 'turn-1' },
    responseHistory: [{ category: 'transport_unknown', reason: 'pipeline_source_unavailable' }]
  })
  expect(reports).toEqual(['Plan complete'])
  expect(await call('pipeline.v2.reconcile', request)).toMatchObject({ ok: true })
  expect(reports).toEqual(['Plan complete'])
  expect(store.getV2('run-1').usedInvocations).toBe(1)
})
it('reconciles only a proven settled invocation and retries only through an explicit bounded new visit', async () => {
  const { store, ports } = harness
  store.templatesV2.saveDraft({
    requestId: 'recovery-draft',
    projectId: 'project-1',
    expectedRevision: 0,
    draft: gatedV2Template()
  })
  store.templatesV2.publish({
    requestId: 'recovery-publish',
    projectId: 'project-1',
    draftId: 'development',
    expectedRevision: 1
  })
  v2Mutation(store, {
    kind: 'reserve',
    invocationId: 'uncertain-worker',
    purpose: 'stage',
    sourceRevision: fixtureSource
  })
  v2Mutation(store, {
    kind: 'bind',
    invocationId: 'uncertain-worker',
    dispatchId: 'old-dispatch',
    session: fixtureSession
  })
  const uncertain = v2Mutation(store, { kind: 'uncertain', reason: 'pipeline_launch_unconfirmed' })
  const request = {
    ...scope,
    requestId: 'reconcile-existing',
    expectedRevision: uncertain.revision
  }
  expect(await call('pipeline.v2.reconcile', request)).toMatchObject({
    ok: false,
    error: { message: 'pipeline_reconciliation_required' }
  })
  expect(store.getV2('run-1').revision).toBe(uncertain.revision)
  ports.settled = async () => true
  const response = await call('pipeline.v2.reconcile', request)
  expect(response).toMatchObject({
    ok: true,
    result: {
      run: { state: 'waiting_owner', waitReason: 'interrupted', usedInvocations: 1 },
      receipt: { requestId: request.requestId, kind: 'reconcile' }
    }
  })
  expect(await call('pipeline.v2.reconcile', request)).toMatchObject({ ok: true })
  const reconciled = store.getV2('run-1')
  expect(
    await call('pipeline.v2.retry', {
      ...scope,
      requestId: 'retry-stage',
      expectedRevision: reconciled.revision
    })
  ).toMatchObject({
    ok: true,
    result: { run: { state: 'running', stageId: 'plan', visitCount: 2, usedInvocations: 1 } }
  })
  expect(store.getV2('run-1').visits[0].state).toBe('interrupted')
})
