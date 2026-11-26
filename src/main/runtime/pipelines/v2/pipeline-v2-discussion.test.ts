import { afterEach, beforeEach, expect, it } from 'vitest'
import { PipelineStore } from '../pipeline-store'
import { PipelineController, type PipelinePorts } from '../pipeline-controller'
import type { PipelineV2Ports } from './pipeline-v2-execution'
import { discussPipelineV2, synchronizePipelineV2Session } from './pipeline-v2-discussion'
import { observePipelineV2RawInput } from './pipeline-v2-session-input'
import { createPipelineOwnerActions } from './pipeline-v2-owner-actions'
import { discussPipelineV2BoundSession } from './pipeline-v2-bound-session'
import { pipelineV2Fingerprint } from '../../../../shared/pipelines/v2/pipeline-v2-fingerprint'
import {
  fixtureSession,
  fixtureSource,
  gatedV2Template,
  pipelineV2AdmissionFixture,
  settleV2Stage,
  v2Mutation
} from './pipeline-v2.test-fixture'

let store: PipelineStore
let ports: PipelineV2Ports
let service: Parameters<typeof discussPipelineV2>[0]
const legacy: PipelinePorts = {
  start: async () => {
    throw new Error('Unexpected legacy launch')
  },
  settled: async () => false,
  sourceRevision: async () => fixtureSource,
  reviewCommit: async () => fixtureSource,
  checks: async () => ({ passed: true, body: 'ok' })
}
beforeEach(() => {
  store = new PipelineStore(':memory:')
  store.createV2(pipelineV2AdmissionFixture(gatedV2Template()))
  settleV2Stage(store)
  ports = {
    sourceRevision: async () => fixtureSource,
    reviewCommit: async () => fixtureSource,
    settled: async () => true,
    checks: async () => {
      throw new Error('Unexpected checks')
    },
    startInvocation: async (request, _spec, prepared) => {
      prepared({ dispatchId: 'discussion-dispatch', session: fixtureSession })
      v2Mutation(store, {
        kind: 'submit',
        invocationId: request.invocation.id,
        dispatchId: 'discussion-dispatch',
        inputRevision: request.invocation.inputRevision,
        sourceRevision: fixtureSource,
        result: {
          status: 'result',
          outcomeId: 'done',
          summary: 'Plan now explains rollback',
          evidence: {
            stage: 'generic',
            statement: 'Rollback added',
            rationale: 'Owner requested it',
            files: []
          }
        }
      })
      return { state: 'ready', dispatchId: 'discussion-dispatch', session: fixtureSession }
    }
  }
  service = {
    store,
    controller: new PipelineController(store, legacy, ports),
    sourceRevision: ports.sourceRevision,
    assertWorkspace: async () => {},
    wake: () => {}
  }
})
afterEach(() => store.close())
function request() {
  const run = store.getV2('run-1')
  return {
    id: run.id,
    requestId: 'discussion-1',
    expectedRevision: run.revision,
    expectedInstanceId: run.workspace.instanceId,
    pin: run.pendingDecision!,
    message: 'Add rollback to the plan'
  }
}
it('does_not_report_accepted_discussion_without_a_bound_delivery_when_version_is_disabled', async () => {
  ports.definitionEnabled = () => false
  const result = await discussPipelineV2(service, request())
  expect(result.state).toBe('outcome_unknown')
  expect(store.getV2('run-1')).toMatchObject({ state: 'paused', definitionEnabled: false })
})
it('a_bound_session_without_the_durable_delivery_receipt_is_not_an_accepted_replay', async () => {
  const input = {
    requestId: 'prepared-only',
    sessionId: fixtureSession.sessionId,
    message: 'Explain rollback',
    hasAttachments: false
  }
  const run = store.getV2('run-1')
  const invocationId = `discussion:${pipelineV2Fingerprint({ id: run.id, requestId: input.requestId })}`
  v2Mutation(
    store,
    {
      kind: 'reserve',
      invocationId,
      purpose: 'discussion',
      sourceRevision: fixtureSource,
      pin: run.pendingDecision,
      message: input.message,
      clientPayloadDigest: pipelineV2Fingerprint(input)
    },
    input.requestId
  )
  v2Mutation(store, {
    kind: 'bind',
    invocationId,
    dispatchId: 'prepared-only-dispatch',
    session: fixtureSession
  })
  const result = await discussPipelineV2BoundSession({ ...service, v2Ports: ports }, input)
  expect(result).toMatchObject({
    handled: true,
    accepted: false,
    receipt: { state: 'outcome_unknown' }
  })
})
it('rejects_an_oversized_discussion_context_before_spending_the_invocation_budget', async () => {
  store.close()
  store = new PipelineStore(':memory:')
  const admission = pipelineV2AdmissionFixture(gatedV2Template())
  admission.task = 't'.repeat(10000)
  store.createV2(admission)
  settleV2Stage(store)
  service = { ...service, store, controller: new PipelineController(store, legacy, ports) }
  const input = { ...request(), message: 'm'.repeat(3990) }
  await expect(discussPipelineV2(service, input)).rejects.toThrow('pipeline_context_budget')
  expect(store.getV2('run-1')).toMatchObject({
    state: 'waiting_owner',
    waitReason: 'owner_gate',
    usedInvocations: 1
  })
  expect(store.getV2('run-1').activeInvocationId).toBeUndefined()
})
function accept() {
  const run = store.getV2('run-1')
  return {
    id: run.id,
    workspaceId: run.workspace.id,
    projectId: run.workspace.projectId,
    expectedRuntimeId: 'runtime-discussion',
    mutation: {
      requestId: 'accept',
      expectedRevision: run.revision,
      expectedInstanceId: run.workspace.instanceId,
      command: { kind: 'decide' as const, ...run.pendingDecision!, action: 'accept' as const }
    }
  }
}
it('discussion_updates_candidate_but_does_not_accept', async () => {
  const input = request()
  const stale = accept()
  expect(await discussPipelineV2(service, input)).toMatchObject({
    state: 'ready',
    dispatchId: 'discussion-dispatch'
  })
  await service.controller.advance('run-1')
  const run = store.getV2('run-1')
  expect(run).toMatchObject({ state: 'waiting_owner', stageId: 'plan', usedInvocations: 2 })
  expect(run.pendingDecision?.candidateId).not.toBe(input.pin.candidateId)
  expect(run.pendingDecision?.discussionRevision).toBe(1)
  expect(run.candidates.map((value) => value.summary)).toEqual([
    'plan result',
    'Plan now explains rollback'
  ])
  await expect(
    createPipelineOwnerActions({
      ...service,
      getRuntimeId: () => 'runtime-discussion'
    }).resolveDecision(stale)
  ).rejects.toThrow('pipeline_revision_conflict')
})
it('lost_send_reply_is_not_second_send', async () => {
  const input = request()
  ports.startInvocation = async (_request, _spec, prepared) => {
    prepared({ dispatchId: 'lost-reply-dispatch', session: fixtureSession })
    throw new Error('Lost delivery reply')
  }
  expect(await discussPipelineV2(service, input)).toMatchObject({ state: 'outcome_unknown' })
  ports.startInvocation = async () => {
    throw new Error('Duplicate delivery')
  }
  expect(await discussPipelineV2(service, input)).toMatchObject({ state: 'outcome_unknown' })
  expect(store.getV2('run-1')).toMatchObject({
    state: 'reconciliation_required',
    usedInvocations: 2
  })
})
it('queued_discussion_blocks_accept', async () => {
  let release!: () => void
  const delivered = new Promise<void>((resolve) => {
    release = resolve
  })
  let prepared!: () => void
  const preparedSignal = new Promise<void>((resolve) => {
    prepared = resolve
  })
  ports.startInvocation = async (_request, _spec, bind) => {
    bind({ dispatchId: 'queued-dispatch', session: fixtureSession })
    prepared()
    await delivered
    return { state: 'ready', dispatchId: 'queued-dispatch', session: fixtureSession }
  }
  const pending = discussPipelineV2(service, request())
  await preparedSignal
  await expect(
    createPipelineOwnerActions({
      ...service,
      getRuntimeId: () => 'runtime-discussion'
    }).resolveDecision(accept())
  ).rejects.toThrow('pipeline_owner_decision_required')
  release()
  await pending
  expect(store.getV2('run-1').stageId).toBe('plan')
})
it('raw_input_requires_sync', async () => {
  observePipelineV2RawInput(store, fixtureSession, {
    receiptId: 'raw-input-1',
    accepted: true,
    queryReply: false
  })
  await expect(
    createPipelineOwnerActions({
      ...service,
      getRuntimeId: () => 'runtime-discussion'
    }).resolveDecision(accept())
  ).rejects.toThrow('pipeline_owner_decision_required')
  await expect(discussPipelineV2(service, request())).rejects.toThrow(
    'pipeline_session_sync_required'
  )
  await synchronizePipelineV2Session(service, request())
  await service.controller.advance('run-1')
  expect(store.getV2('run-1')).toMatchObject({ state: 'waiting_owner', stageId: 'plan' })
  expect(store.getV2('run-1').unverifiedSessionInput).toBeUndefined()
  expect(store.getV2('run-1').pendingDecision?.discussionRevision).toBe(1)
})
it('query_reply_and_rejected_raw_input_do_not_invalidate_candidate', () => {
  observePipelineV2RawInput(store, fixtureSession, {
    receiptId: 'query',
    accepted: true,
    queryReply: true
  })
  observePipelineV2RawInput(store, fixtureSession, {
    receiptId: 'rejected',
    accepted: false,
    queryReply: false
  })
  expect(store.getV2('run-1').unverifiedSessionInput).toBeUndefined()
})
it('explicit_sync_attests_changed_source_without_accepting_it', async () => {
  const input = request()
  service.sourceRevision = async () => 'b'.repeat(64)
  await expect(discussPipelineV2(service, input)).rejects.toThrow('pipeline_source_changed')
  ports.sourceRevision = service.sourceRevision
  ports.startInvocation = async (request, _spec, prepared) => {
    prepared({ dispatchId: 'sync-dispatch', session: fixtureSession })
    v2Mutation(store, {
      kind: 'submit',
      invocationId: request.invocation.id,
      dispatchId: 'sync-dispatch',
      inputRevision: request.invocation.inputRevision,
      sourceRevision: 'b'.repeat(64),
      result: {
        status: 'result',
        outcomeId: 'done',
        summary: 'Updated source assessed',
        evidence: {
          stage: 'generic',
          statement: 'Source synchronized',
          rationale: 'Owner requested synchronization',
          files: []
        }
      }
    })
    return { state: 'ready', dispatchId: 'sync-dispatch', session: fixtureSession }
  }
  await synchronizePipelineV2Session(service, input)
  await service.controller.advance('run-1')
  expect(store.getV2('run-1')).toMatchObject({
    state: 'waiting_owner',
    stageId: 'plan',
    sourceRevision: 'b'.repeat(64)
  })
})
it('raw_input_during_sync_remains_unverified_after_its_candidate_settles', async () => {
  observePipelineV2RawInput(store, fixtureSession, {
    receiptId: 'raw-before',
    accepted: true,
    queryReply: false
  })
  const native = ports.startInvocation
  ports.startInvocation = async (...args) => {
    const receipt = await native(...args)
    observePipelineV2RawInput(store, fixtureSession, {
      receiptId: 'raw-during',
      accepted: true,
      queryReply: false
    })
    return receipt
  }
  await synchronizePipelineV2Session(service, request())
  await service.controller.advance('run-1')
  expect(store.getV2('run-1').unverifiedSessionInput).toEqual({
    sessionId: 'primary-session',
    receiptId: 'raw-during'
  })
  await expect(
    createPipelineOwnerActions({
      ...service,
      getRuntimeId: () => 'runtime-discussion'
    }).resolveDecision(accept())
  ).rejects.toThrow('pipeline_owner_decision_required')
})
it('bound_session_replay_after_candidate_changes_returns_original_delivery_receipt', async () => {
  const runtime = { ...service, v2Ports: ports }
  const input = {
    requestId: 'composer-send-1',
    sessionId: 'primary-session',
    message: 'Explain rollback',
    hasAttachments: false
  }
  const first = await discussPipelineV2BoundSession(runtime, input)
  await service.controller.advance('run-1')
  expect(await discussPipelineV2BoundSession(runtime, input)).toEqual(first)
  await expect(
    discussPipelineV2BoundSession(runtime, { ...input, message: 'Changed duplicate' })
  ).rejects.toThrow('pipeline_request_conflict')
})
it('unbound_chat_keeps_its_existing_message_size_limit', async () => {
  expect(
    await discussPipelineV2BoundSession(
      { ...service, v2Ports: ports },
      {
        requestId: 'ordinary-chat',
        sessionId: 'unbound-session',
        message: 'task '.repeat(2000),
        hasAttachments: false
      }
    )
  ).toEqual({ handled: false, accepted: false })
})
it('reports a rejected unreserved discussion so the owner can correct it and explicitly send again', async () => {
  expect(
    await discussPipelineV2BoundSession(
      { ...service, v2Ports: ports },
      {
        requestId: 'rejected-attachments',
        sessionId: 'primary-session',
        message: 'Explain rollback',
        hasAttachments: true
      }
    )
  ).toMatchObject({ handled: true, accepted: false, rejected: 'pipeline_discussion_text_only' })
  expect(store.receiptV2('run-1', 'rejected-attachments')).toBeNull()
})
it('reports budget rejection consistently and permits a fresh discussion after owner extension', async () => {
  store.close()
  store = new PipelineStore(':memory:')
  const template = gatedV2Template()
  template.limits.maxInvocations = 1
  store.createV2(pipelineV2AdmissionFixture(template))
  settleV2Stage(store)
  service = { ...service, store, controller: new PipelineController(store, legacy, ports) }
  const runtime = { ...service, v2Ports: ports }
  const input = {
    requestId: 'budget-rejected',
    sessionId: 'primary-session',
    message: 'Explain rollback',
    hasAttachments: false
  }
  expect(await discussPipelineV2BoundSession(runtime, input)).toMatchObject({
    handled: true,
    accepted: false,
    rejected: 'pipeline_budget_exhausted'
  })
  expect(await discussPipelineV2BoundSession(runtime, input)).toMatchObject({
    handled: true,
    accepted: false,
    rejected: 'pipeline_budget_exhausted'
  })
  v2Mutation(store, { kind: 'extend_budget', maxInvocations: 2 })
  expect(store.getV2('run-1')).toMatchObject({ state: 'waiting_owner', waitReason: 'owner_gate' })
  expect(
    await discussPipelineV2BoundSession(runtime, { ...input, requestId: 'after-budget-extension' })
  ).toMatchObject({ handled: true, accepted: true })
  expect(store.getV2('run-1').invocations.at(-1)?.message).toBe('Explain rollback')
})
