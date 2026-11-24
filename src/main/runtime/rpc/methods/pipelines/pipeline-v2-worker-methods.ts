import { defineMethod } from '../../core'
import {
  PipelineV2WorkerContextParams,
  PipelineV2WorkerSubmitParams
} from '../../../../../shared/rpc-contract/pipeline-v2-worker-params'
import { callerDispatch } from './pipeline-caller-dispatch'
import { assemblePipelineV2Context } from '../../../pipelines/v2/pipeline-v2-context'
import { validatePipelineFileEvidence } from '../../../pipelines/pipeline-evidence'
import { scopedPipelineV2 } from './pipeline-v2-scope'
import { pipelineV2RequiresReviewCommit } from '../../../../../shared/pipelines/v2/pipeline-v2-review-policy'

export const PIPELINE_V2_WORKER_METHODS = [
  defineMethod({
    name: 'pipeline.v2.context',
    permission: 'workspace',
    params: PipelineV2WorkerContextParams,
    handler: async (input, ctx) => {
      const service = ctx.runtime.pipelineRuntime
      const run = await scopedPipelineV2(ctx, input)
      const visit = input.visitId
        ? run.visits.find((value) => value.id === input.visitId)
        : undefined
      if (input.visitId && !visit) {
        throw new Error('pipeline_visit_missing')
      }
      const view = visit
        ? {
            ...run,
            stageId: visit.stageId,
            currentVisitId: visit.id,
            activeInvocationId: visit.id === run.currentVisitId ? run.activeInvocationId : undefined
          }
        : run
      const history = await service.store.historyContext(run.id, input)
      if (
        input.artifactId &&
        visit &&
        !history &&
        !view.candidates.some(
          (value) => value.id === input.artifactId && value.visitId === visit.id
        )
      ) {
        throw new Error('pipeline_artifact_not_found')
      }
      const context =
        history ??
        (input.visitCursor !== undefined
          ? assemblePipelineV2Context(run, { visitCursor: input.visitCursor, limit: input.limit })
          : input.artifactId
            ? assemblePipelineV2Context(view, { artifactId: input.artifactId })
            : input.artifactCursor !== undefined
              ? assemblePipelineV2Context(
                  visit
                    ? {
                        ...view,
                        candidates: view.candidates.filter((value) => value.visitId === visit.id)
                      }
                    : view,
                  { artifactCursor: input.artifactCursor, limit: input.limit }
                )
              : assemblePipelineV2Context(view))
      return {
        contractVersion: 2 as const,
        ...context,
        historical: visit ? visit.id !== run.currentVisitId : false,
        sourceRevision: await service.v2Ports.sourceRevision(run.workspace)
      }
    }
  }),
  defineMethod({
    name: 'pipeline.v2.submit',
    permission: 'workspace',
    params: PipelineV2WorkerSubmitParams,
    handler: async ({ id, mutation }, ctx) => {
      const service = ctx.runtime.pipelineRuntime
      const run = await service.store.getV2(id)
      await service.assertWorkspace(run.workspace)
      const command = mutation.command
      if (
        command.kind !== 'submit' ||
        command.dispatchId !== (await callerDispatch(ctx, run.workspace.id))
      ) {
        throw new Error('pipeline_submission_denied')
      }
      const stage = run.definition.stages.find((value) => value.id === run.stageId)!
      if (stage.kind !== 'agent') {
        throw new Error('pipeline_submission_denied')
      }
      if (!(await service.store.receiptV2(id, mutation.requestId))) {
        const invocation = run.invocations.find((value) => value.id === run.activeInvocationId)
        if (
          pipelineV2RequiresReviewCommit(run.definition, stage) &&
          (!invocation?.reviewCommit ||
            (await service.v2Ports.reviewCommit(run.workspace)) !== invocation.reviewCommit)
        ) {
          throw new Error('pipeline_review_commit_changed')
        }
        if (command.result.evidence?.stage === 'docs') {
          await validatePipelineFileEvidence(run, command.result.evidence)
        }
      }
      if (
        !(await service.store.receiptV2(id, mutation.requestId)) &&
        (await service.v2Ports.sourceRevision(run.workspace)) !== command.sourceRevision
      ) {
        throw new Error('pipeline_source_changed')
      }
      await service.store.commandV2(id, mutation)
      service.wake()
      return {
        contractVersion: 2 as const,
        receipt: await service.store.receiptV2(id, mutation.requestId)
      }
    }
  })
]
