import type { HandlerContext } from '../dispatch/dispatch'
import { getRequiredStringFlag } from '../arguments/flags'
import { RuntimeClientError } from '../runtime/connection/types'
import { printResult } from '../output/command-result-output'
import { readPipelineInput } from './pipeline-input-json'
import { pipelineV2Method } from '../pipeline-v2-command-paths'
import * as schemas from '../../shared/rpc-contract/pipeline-v2-params'
import { PipelineV2WorkerSubmitParams } from '../../shared/rpc-contract/pipeline-v2-worker-params'

const schemaByCommand = new Map(
  Object.entries({
    status: schemas.PipelineV2RunParams,
    context: schemas.PipelineV2ContextParams,
    events: schemas.PipelineV2EventsParams,
    list: schemas.PipelineV2ListParams,
    profiles: schemas.PipelineV2ListParams,
    describe: schemas.PipelineV2DescribeParams,
    pause: schemas.PipelineV2ControlParams,
    resume: schemas.PipelineV2ControlParams,
    revalidate: schemas.PipelineV2ControlParams,
    reconcile: schemas.PipelineV2ControlParams,
    retry: schemas.PipelineV2ControlParams,
    receipt: schemas.PipelineV2ReceiptParams,
    discuss: schemas.PipelineV2DiscussParams,
    requests: schemas.PipelineV2ListParams,
    'template list': schemas.PipelineV2TemplateListParams,
    'template show': schemas.PipelineV2TemplateShowParams,
    'template save': schemas.PipelineV2TemplateSaveParams,
    'template delete': schemas.PipelineV2TemplateDeleteParams,
    'template validate': schemas.PipelineV2TemplateValidateParams,
    'template publish-request': schemas.PipelineV2TemplatePublishRequestParams,
    'template disable-request': schemas.PipelineV2TemplateDisableRequestParams,
    'template receipt': schemas.PipelineV2RequestReceiptParams,
    'decision request': schemas.PipelineV2DecisionRequestParams,
    'budget request': schemas.PipelineV2BudgetRequestParams,
    'decision receipt': schemas.PipelineV2RequestReceiptParams,
    'budget receipt': schemas.PipelineV2RequestReceiptParams
  })
)
export async function handlePipelineV2(command: string, ctx: HandlerContext): Promise<void> {
  if (ctx.flags.get('api-version') !== '2') {
    throw new RuntimeClientError('invalid_argument', 'This command requires --api-version 2')
  }
  const hasInput = ctx.flags.has('input-file') || ctx.flags.has('input-json')
  let raw: unknown = {}
  if (command === 'submit') {
    raw = {
      id: getRequiredStringFlag(ctx.flags, 'id'),
      mutation: await readPipelineInput(ctx, 65536, true)
    }
  } else if (hasInput) {
    raw = await readPipelineInput(ctx, command === 'template save' ? 320 * 1024 : 65536, true)
  } else {
    const flags: Record<string, unknown> = {}
    for (const [flag, key] of [
      ['id', 'id'],
      ['project-id', 'projectId'],
      ['instance-id', 'expectedInstanceId'],
      ['runtime-id', 'expectedRuntimeId'],
      ['request-id', 'requestId'],
      ['kind', 'kind'],
      ['draft-id', 'draftId'],
      ['stage-id', 'stageId'],
      ['visit-id', 'visitId'],
      ['invocation-id', 'invocationId'],
      ['artifact-id', 'artifactId'],
      ['message', 'message'],
      ['action', 'action']
    ]) {
      if (ctx.flags.has(flag)) {
        flags[key] = getRequiredStringFlag(ctx.flags, flag)
      }
    }
    for (const [flag, key] of [
      ['expected-revision', 'expectedRevision'],
      ['cursor', 'cursor'],
      ['limit', 'limit'],
      ['artifact-cursor', 'artifactCursor'],
      ['visit-cursor', 'visitCursor']
    ]) {
      if (ctx.flags.has(flag)) {
        flags[key] = Number(getRequiredStringFlag(ctx.flags, flag))
      }
    }
    if (ctx.flags.has('full')) {
      flags.full = ctx.flags.get('full') === true || ctx.flags.get('full') === 'true'
    }
    if (ctx.flags.has('enabled-only')) {
      flags.enabledOnly =
        ctx.flags.get('enabled-only') === true || ctx.flags.get('enabled-only') === 'true'
    }
    raw = flags
  }
  const schema = command === 'submit' ? PipelineV2WorkerSubmitParams : schemaByCommand.get(command)
  if (!schema) {
    throw new RuntimeClientError('invalid_argument', 'Unsupported pipeline v2 command')
  }
  const params = schema.parse(raw)
  const response = await ctx.client.call<unknown>(pipelineV2Method(command), params)
  const result = response.result
  if (
    !result ||
    typeof result !== 'object' ||
    !('contractVersion' in result) ||
    result.contractVersion !== 2
  ) {
    throw new RuntimeClientError(
      'incompatible_runtime',
      'Pipeline v2 capability is unavailable; update the selected runtime'
    )
  }
  if (
    'expectedRuntimeId' in params &&
    params.expectedRuntimeId &&
    response._meta.runtimeId !== params.expectedRuntimeId
  ) {
    throw new RuntimeClientError('incompatible_runtime', 'Pipeline runtime identity changed')
  }
  printResult(response, ctx.json, (value) => JSON.stringify(value, null, 2))
}
