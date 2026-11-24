import type { RpcContext } from '../../core'
import type { PipelineV2RunParams } from '../../../../../shared/rpc-contract/pipeline-v2-params'
import {
  evaluatePipelineV2Completion,
  evaluatePipelineV2SourceEvidence
} from '../../../pipelines/v2/pipeline-v2-completion'
import { pipelineV2FindingLedger } from '../../../pipelines/v2/pipeline-v2-finding-ledger'
import type { PipelineV2Run } from '../../../../../shared/pipelines/v2/pipeline-v2-run-contracts'
import { pipelineV2ReentryLimit } from '../../../pipelines/v2/pipeline-v2-routing'

export function assertPipelineV2Runtime(ctx: RpcContext, expected?: string): void {
  if (expected && ctx.runtime.getRuntimeId() !== expected) {
    throw new Error('pipeline_runtime_identity_changed')
  }
}
export async function scopedPipelineV2(ctx: RpcContext, input: PipelineV2RunParams) {
  assertPipelineV2Runtime(ctx, input.expectedRuntimeId)
  const service = ctx.runtime.pipelineRuntime
  const run = service.store.getV2(input.id)
  if (
    (input.projectId && input.projectId !== run.workspace.projectId) ||
    (input.expectedInstanceId && input.expectedInstanceId !== run.workspace.instanceId)
  ) {
    throw new Error('pipeline_workspace_instance_changed')
  }
  await service.assertWorkspace(run.workspace)
  return run
}
export function pipelineV2Summary(run: PipelineV2Run) {
  const reentryStageId =
    run.waitReason === 'budget' && run.pendingTransition?.target.kind === 'stage'
      ? run.pendingTransition.target.stageId
      : run.stageId
  const candidate = run.candidates.find((value) => value.id === run.pendingDecision?.candidateId)
  const invocation =
    run.invocations.find((value) => value.id === run.activeInvocationId) ??
    run.invocations.findLast((value) => value.visitId === run.currentVisitId)
  const {
    message: _message,
    clientPayloadDigest: _client,
    synchronizationReceiptId: _sync,
    responseHistory: _history,
    ...binding
  } = invocation ?? {}
  return {
    id: run.id,
    engineVersion: 2 as const,
    workspace: {
      id: run.workspace.id,
      instanceId: run.workspace.instanceId,
      projectId: run.workspace.projectId,
      hostId: run.workspace.hostId
    },
    revision: run.revision,
    eventSequence: run.eventSequence,
    state: run.state,
    stageId: run.stageId,
    currentVisitId: run.currentVisitId,
    definitionDigest: run.definitionDigest,
    definitionEnabled: run.definitionEnabled,
    sourceRevision: run.sourceRevision,
    reason: run.reason,
    waitReason: run.waitReason,
    pendingDecision: run.pendingDecision,
    setupHold: run.setupHold,
    pendingTransition: run.pendingTransition,
    usedInvocations: run.usedInvocations,
    visitCount: run.visits.length,
    candidateCount: run.candidates.length,
    definition: {
      id: run.definition.id,
      title: run.definition.title,
      version: run.definition.version,
      completionPolicy: { kind: run.definition.completionPolicy.kind },
      limits: run.definition.limits,
      stageCount: run.definition.stages.length,
      stagesTruncated: run.definition.stages.length > 10,
      stages: run.definition.stages.slice(0, 10).map((value) => ({
        id: value.id,
        title: value.title,
        kind: value.kind,
        maxReentries: value.maxReentries,
        ownerGate: value.ownerGate.enabled
      }))
    },
    currentInvocation: invocation ? binding : undefined,
    currentExecutor: run.effectiveExecutors[run.stageId],
    effectiveLimits: {
      maxInvocations: Math.max(
        run.definition.limits.maxInvocations,
        ...run.budgetExtensions.map((value) => value.maxInvocations ?? 0)
      ),
      maxDiscussionTurns: Math.max(
        run.definition.limits.maxDiscussionTurns,
        ...run.budgetExtensions
          .filter((value) => value.visitId === run.currentVisitId)
          .map((value) => value.maxDiscussionTurns ?? 0)
      ),
      maxReentries: pipelineV2ReentryLimit(run, reentryStageId),
      ...(reentryStageId !== run.stageId ? { reentryStageId } : {}),
      usedDiscussionTurns: run.visits.find((value) => value.id === run.currentVisitId)!
        .discussionTurns,
      usedReentries: Math.max(
        0,
        ...run.visits
          .filter((value) => value.stageId === reentryStageId)
          .map((value) => value.attempt)
      )
    },
    candidate: candidate
      ? {
          id: candidate.id,
          digest: candidate.digest,
          summaryPreview: candidate.summary.slice(0, 1000),
          summaryTruncated: candidate.summary.length > 1000,
          sessionId: candidate.sessionId
        }
      : undefined
  }
}
export async function pipelineV2Status(ctx: RpcContext, input: PipelineV2RunParams) {
  const run = await scopedPipelineV2(ctx, input)
  const source = await ctx.runtime.pipelineRuntime.v2Ports
    .sourceRevision(run.workspace)
    .catch(() => null)
  return {
    contractVersion: 2 as const,
    run: pipelineV2Summary(run),
    findingLedger: pipelineV2FindingLedger(
      run,
      source ?? '',
      source !== null && evaluatePipelineV2SourceEvidence(run, source).ready
    ),
    sourceRevision: source,
    sourceAvailable: source !== null,
    ...(source === null
      ? {
          workflowComplete: run.state === 'completed',
          ready: false,
          currentEvidence: false,
          reason: 'pipeline_source_unavailable'
        }
      : evaluatePipelineV2Completion(run, source))
  }
}
