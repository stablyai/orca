import { defineMethod, type RpcContext } from '../../core'
import {
  PipelineV2ControlParams,
  PipelineV2ReceiptParams
} from '../../../../../shared/rpc-contract/pipeline-v2-params'
import type { z } from 'zod'
import { scopedPipelineV2, pipelineV2Summary } from './pipeline-v2-scope'
import {
  pipelineV2DeliveryReceipt,
  pipelineV2RefusalReceipt
} from '../../../pipelines/v2/pipeline-v2-delivery-receipt'
import { pipelineV2Fingerprint } from '../../../../../shared/pipelines/v2/pipeline-v2-fingerprint'

async function control(
  kind: 'pause' | 'resume' | 'revalidate',
  input: z.infer<typeof PipelineV2ControlParams>,
  ctx: RpcContext
) {
  const run = await scopedPipelineV2(ctx, input)
  const service = ctx.runtime.pipelineRuntime
  const previous = service.store.receiptV2(input.id, input.requestId)
  if (!previous && kind === 'resume') {
    service.store.templatesV2.resolve({
      engineVersion: 2,
      projectId: run.workspace.projectId,
      id: run.definition.id,
      version: run.definition.version,
      digest: run.definitionDigest
    })
  }
  const command =
    kind === 'revalidate'
      ? {
          kind,
          sourceRevision:
            previous?.sourceRevision ?? (await service.v2Ports.sourceRevision(run.workspace))
        }
      : { kind }
  const next = service.store.commandV2(input.id, {
    requestId: input.requestId,
    expectedRevision: input.expectedRevision,
    expectedInstanceId: input.expectedInstanceId,
    command
  })
  service.wake()
  return {
    contractVersion: 2 as const,
    run: pipelineV2Summary(next),
    receipt: service.store.receiptV2(input.id, input.requestId)
  }
}
export const PIPELINE_V2_CONTROL_METHODS = [
  defineMethod({
    name: 'pipeline.v2.pause',
    permission: 'workspace',
    params: PipelineV2ControlParams,
    handler: (input, ctx) => control('pause', input, ctx)
  }),
  defineMethod({
    name: 'pipeline.v2.resume',
    permission: 'host-admin',
    params: PipelineV2ControlParams,
    handler: (input, ctx) => control('resume', input, ctx)
  }),
  defineMethod({
    name: 'pipeline.v2.revalidate',
    permission: 'host-admin',
    params: PipelineV2ControlParams,
    handler: (input, ctx) => control('revalidate', input, ctx)
  }),
  defineMethod({
    name: 'pipeline.v2.receipt',
    permission: 'workspace',
    params: PipelineV2ReceiptParams,
    handler: async (input, ctx) => {
      const run = await scopedPipelineV2(ctx, input)
      const receipt = ctx.runtime.pipelineRuntime.store.receiptV2(input.id, input.requestId)
      if (
        receipt &&
        (receipt.kind !== input.kind ||
          receipt.inputRevision !== input.expectedRevision ||
          receipt.workspaceInstanceId !== input.expectedInstanceId)
      ) {
        throw new Error('pipeline_request_conflict')
      }
      const invocation =
        input.kind === 'reserve'
          ? run.invocations.find(
              (value) =>
                value.id ===
                `discussion:${pipelineV2Fingerprint({ id: input.id, requestId: input.requestId })}`
            )
          : undefined
      return {
        contractVersion: 2 as const,
        receipt,
        ...(input.kind === 'reserve'
          ? {
              delivery: invocation
                ? (pipelineV2DeliveryReceipt(ctx.runtime.pipelineRuntime.store, invocation) ?? null)
                : null,
              refusal: invocation
                ? (pipelineV2RefusalReceipt(ctx.runtime.pipelineRuntime.store, invocation) ?? null)
                : null
            }
          : {})
      }
    }
  })
]
