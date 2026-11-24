import { defineMethod, type RpcContext } from '../../core'
import {
  PipelineV2DecisionRequestParams,
  PipelineV2BudgetRequestParams,
  PipelineV2RequestReceiptParams,
  PipelineV2ListParams
} from '../../../../../shared/rpc-contract/pipeline-v2-params'
import type { z } from 'zod'
import { scopedPipelineV2, pipelineV2Summary, assertPipelineV2Runtime } from './pipeline-v2-scope'
import { transitionPipelineV2 } from '../../../pipelines/v2/pipeline-v2-state'

async function receipt(input: z.infer<typeof PipelineV2RequestReceiptParams>, ctx: RpcContext) {
  assertPipelineV2Runtime(ctx, input.expectedRuntimeId)
  const store = ctx.runtime.pipelineRuntime.store
  const request = await store.ownerRequestsV2.get(input.projectId, input.requestId)
  if (request && (request.kind === 'decision' || request.kind === 'budget')) {
    await scopedPipelineV2(ctx, {
      id: request.input.id,
      projectId: request.projectId,
      expectedInstanceId: request.input.expectedInstanceId
    })
    return {
      contractVersion: 2 as const,
      request,
      receipt: await store.receiptV2(request.input.id, input.requestId)
    }
  }
  return { contractVersion: 2 as const, request, receipt: null }
}
async function propose(
  kind: 'decision' | 'budget',
  input:
    | z.infer<typeof PipelineV2DecisionRequestParams>
    | z.infer<typeof PipelineV2BudgetRequestParams>,
  ctx: RpcContext
) {
  const run = await scopedPipelineV2(ctx, input)
  const store = ctx.runtime.pipelineRuntime.store
  if (!(await store.ownerRequestsV2.get(input.projectId, input.requestId))) {
    if (run.revision !== input.expectedRevision) {
      throw new Error('pipeline_revision_conflict')
    }
    const command =
      'pin' in input
        ? {
            kind: 'decide' as const,
            ...input.pin,
            action: input.action,
            ...(input.comment ? { comment: input.comment } : {})
          }
        : { kind: 'extend_budget' as const, ...input.extension }
    transitionPipelineV2(run, {
      requestId: input.requestId,
      expectedRevision: input.expectedRevision,
      expectedInstanceId: input.expectedInstanceId,
      command
    })
  }
  const request = await store.ownerRequestsV2.request(kind, input)
  return { contractVersion: 2 as const, request, run: pipelineV2Summary(run) }
}
export const PIPELINE_V2_REQUEST_METHODS = [
  defineMethod({
    name: 'pipeline.v2.decision.request',
    permission: 'workspace',
    params: PipelineV2DecisionRequestParams,
    handler: (input, ctx) => propose('decision', input, ctx)
  }),
  defineMethod({
    name: 'pipeline.v2.budget.request',
    permission: 'workspace',
    params: PipelineV2BudgetRequestParams,
    handler: (input, ctx) => propose('budget', input, ctx)
  }),
  defineMethod({
    name: 'pipeline.v2.decision.receipt',
    permission: 'workspace',
    params: PipelineV2RequestReceiptParams,
    handler: receipt
  }),
  defineMethod({
    name: 'pipeline.v2.budget.receipt',
    permission: 'workspace',
    params: PipelineV2RequestReceiptParams,
    handler: receipt
  }),
  defineMethod({
    name: 'pipeline.v2.requests',
    permission: 'workspace',
    params: PipelineV2ListParams,
    handler: async (input, ctx) => {
      assertPipelineV2Runtime(ctx, input.expectedRuntimeId)
      return {
        contractVersion: 2 as const,
        projectId: input.projectId,
        ...(await ctx.runtime.pipelineRuntime.store.ownerRequestsV2.list(
          input.projectId,
          input.cursor,
          input.limit
        ))
      }
    }
  })
]
