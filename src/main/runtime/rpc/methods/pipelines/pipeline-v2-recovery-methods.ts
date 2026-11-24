import { defineMethod, type RpcContext } from '../../core'
import { PipelineV2ControlParams } from '../../../../../shared/rpc-contract/pipeline-v2-params'
import type { z } from 'zod'
import { scopedPipelineV2, pipelineV2Summary, assertPipelineV2Runtime } from './pipeline-v2-scope'
import {
  readPipelineV2ResponseRecovery,
  finishPipelineV2ResponseRecovery
} from '../../../pipelines/v2/pipeline-v2-response-recovery'

async function recover(
  kind: 'reconcile' | 'retry',
  input: z.infer<typeof PipelineV2ControlParams>,
  ctx: RpcContext
) {
  const run = await scopedPipelineV2(ctx, input)
  const service = ctx.runtime.pipelineRuntime
  const previous = await service.store.receiptV2(input.id, input.requestId)
  if (previous) {
    if (
      previous.kind !== kind ||
      previous.inputRevision !== input.expectedRevision ||
      previous.workspaceInstanceId !== input.expectedInstanceId
    ) {
      throw new Error('pipeline_request_conflict')
    }
    const current =
      kind === 'reconcile'
        ? await finishPipelineV2ResponseRecovery(service.store, service.v2Ports, run)
        : run
    return { contractVersion: 2 as const, receipt: previous, run: pipelineV2Summary(current) }
  }
  if (run.revision !== input.expectedRevision) {
    throw new Error('pipeline_revision_conflict')
  }
  let command
  if (kind === 'reconcile') {
    const invocation = run.invocations.find((value) => value.id === run.activeInvocationId)
    const recovered =
      run.state === 'reconciliation_required' && invocation?.session && invocation.dispatchId
        ? await readPipelineV2ResponseRecovery(service.store, service.v2Ports, run, invocation)
        : undefined
    const response = recovered?.state === 'result' ? recovered.response : undefined
    if (recovered?.state === 'interrupted' && invocation) {
      await service.v2Ports.completeResponse!(invocation)
    }
    if (
      run.state !== 'reconciliation_required' ||
      !invocation?.dispatchId ||
      !invocation.session ||
      (!response &&
        !(invocation.session.kind === 'checks'
          ? await service.store.completedCheckEffect(`pipeline-v2:${invocation.id}`)
          : await service.v2Ports.settled(invocation.dispatchId)))
    ) {
      throw new Error('pipeline_reconciliation_required')
    }
    command = { kind, invocationId: invocation.id, ...(response ? { response } : {}) }
  } else {
    await service.store.templatesV2.resolve({
      engineVersion: 2,
      projectId: run.workspace.projectId,
      id: run.definition.id,
      version: run.definition.version,
      digest: run.definitionDigest
    })
    command = { kind, sourceRevision: await service.v2Ports.sourceRevision(run.workspace) }
  }
  await service.assertWorkspace(run.workspace)
  assertPipelineV2Runtime(ctx, input.expectedRuntimeId)
  let next = await service.store.commandV2(input.id, {
    requestId: input.requestId,
    expectedRevision: input.expectedRevision,
    expectedInstanceId: input.expectedInstanceId,
    command
  })
  if (kind === 'reconcile') {
    next = await finishPipelineV2ResponseRecovery(service.store, service.v2Ports, next)
  }
  service.wake()
  return {
    contractVersion: 2 as const,
    receipt: await service.store.receiptV2(input.id, input.requestId),
    run: pipelineV2Summary(next)
  }
}
export const PIPELINE_V2_RECOVERY_METHODS = [
  defineMethod({
    name: 'pipeline.v2.reconcile',
    permission: 'host-admin',
    params: PipelineV2ControlParams,
    handler: (input, ctx) =>
      ctx.runtime.pipelineRuntime.controller.withInvocationLock(input.id, () =>
        recover('reconcile', input, ctx)
      )
  }),
  defineMethod({
    name: 'pipeline.v2.retry',
    permission: 'host-admin',
    params: PipelineV2ControlParams,
    handler: (input, ctx) =>
      ctx.runtime.pipelineRuntime.controller.withInvocationLock(input.id, () =>
        recover('retry', input, ctx)
      )
  })
]
