import type { PipelineController } from '../pipeline-controller'
import { PipelineV2DiscussionInput } from '../../../../shared/pipelines/v2/pipeline-v2-discussion-contracts'
import type { PipelineV2InvocationReceipt } from '../../../../shared/pipelines/v2/pipeline-v2-results'
import type { PipelineV2OwnerDependencies } from './pipeline-v2-owner-actions'
import { pipelineV2Fingerprint } from '../../../../shared/pipelines/v2/pipeline-v2-fingerprint'
import { pipelineV2DeliveryReceipt, pipelineV2RefusalReceipt } from './pipeline-v2-delivery-receipt'
import { assemblePipelineV2Context } from './pipeline-v2-context'
import { pipelineV2RequiresReviewCommit } from '../../../../shared/pipelines/v2/pipeline-v2-review-policy'

type DiscussionRuntime = PipelineV2OwnerDependencies & {
  controller: PipelineController
  assertRuntime?: () => void
}
async function send(
  runtime: DiscussionRuntime,
  raw: unknown,
  purpose: 'discussion' | 'synchronize'
): Promise<PipelineV2InvocationReceipt> {
  const input = PipelineV2DiscussionInput.parse(raw)
  runtime.assertRuntime?.()
  const run = runtime.store.getV2(input.id)
  await runtime.assertWorkspace(run.workspace)
  const receipt = runtime.store.receiptV2(input.id, input.requestId)
  const source = receipt?.sourceRevision ?? (await runtime.sourceRevision(run.workspace))
  if (!receipt && purpose !== 'synchronize' && source !== input.pin.sourceRevision) {
    throw new Error('pipeline_source_changed')
  }
  const invocationId = `discussion:${pipelineV2Fingerprint({ id: input.id, requestId: input.requestId })}`
  const stage = run.definition.stages.find((value) => value.id === run.stageId)!
  const previous = run.invocations.find((value) => value.id === invocationId)
  const reviewCommit = pipelineV2RequiresReviewCommit(run.definition, stage)
    ? (previous?.reviewCommit ?? (await runtime.reviewCommit?.(run.workspace)))
    : undefined
  if (pipelineV2RequiresReviewCommit(run.definition, stage) && !reviewCommit) {
    throw new Error('pipeline_review_requires_clean_commit')
  }
  if (!receipt) {
    const visit = run.visits.find((value) => value.id === run.currentVisitId)!
    assemblePipelineV2Context({
      ...run,
      revision: run.revision + 1,
      activeInvocationId: invocationId,
      invocations: [
        ...run.invocations,
        {
          id: invocationId,
          stageId: stage.id,
          visitId: visit.id,
          purpose,
          state: 'reserved',
          inputRevision: run.revision,
          sourceRevision: source,
          discussionRevision: visit.discussionTurns + 1,
          dispatchId: 'd'.repeat(256),
          message: input.message,
          ...(reviewCommit ? { reviewCommit } : {})
        }
      ]
    })
  }
  runtime.assertRuntime?.()
  const reserved = runtime.store.commandV2(input.id, {
    requestId: input.requestId,
    expectedRevision: input.expectedRevision,
    expectedInstanceId: input.expectedInstanceId,
    command: {
      kind: 'reserve',
      invocationId,
      purpose,
      sourceRevision: source,
      pin: input.pin,
      message: input.message,
      ...(reviewCommit ? { reviewCommit } : {}),
      ...(input.clientPayloadDigest ? { clientPayloadDigest: input.clientPayloadDigest } : {})
    }
  })
  if (!reserved.invocations.some((value) => value.id === invocationId)) {
    throw new Error('pipeline_budget_exhausted')
  }
  await runtime.controller.advance(input.id)
  const current = runtime.store.getV2(input.id)
  const invocation = current.invocations.find((value) => value.id === invocationId)!
  runtime.wake()
  const refusal = pipelineV2RefusalReceipt(runtime.store, invocation)
  if (refusal) {
    return { state: refusal.state, reason: refusal.reason }
  }
  return {
    state:
      current.state === 'reconciliation_required' ||
      !pipelineV2DeliveryReceipt(runtime.store, invocation)
        ? 'outcome_unknown'
        : 'ready',
    ...(invocation.dispatchId ? { dispatchId: invocation.dispatchId } : {}),
    ...(invocation.session ? { session: invocation.session } : {})
  }
}
export function discussPipelineV2(
  runtime: DiscussionRuntime,
  input: PipelineV2DiscussionInput
): Promise<PipelineV2InvocationReceipt> {
  return send(runtime, input, 'discussion')
}
export function synchronizePipelineV2Session(
  runtime: DiscussionRuntime,
  input: unknown
): Promise<PipelineV2InvocationReceipt> {
  return send(runtime, input, 'synchronize')
}
