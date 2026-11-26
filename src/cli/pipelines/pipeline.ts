import type { CommandHandler, HandlerContext } from '../dispatch/dispatch'
import { getRequiredStringFlag } from '../arguments/flags'
import { RuntimeClientError } from '../runtime/connection/types'
import { printResult } from '../output/command-result-output'
import { readPipelineInput as input } from './pipeline-input-json'
import { handlePipelineV2 } from './pipeline-v2'
import { PIPELINE_V2_ONLY_COMMANDS } from '../pipeline-v2-command-paths'
import {
  PipelineControlParams,
  PipelineSubmitParams,
  PipelineConfigureParams,
  PipelineReceiptParams
} from '../../shared/rpc-contract/pipeline-params'

export const PIPELINE_HANDLERS: Record<string, CommandHandler> = Object.fromEntries(
  [
    'list',
    'profiles',
    'describe',
    'status',
    'context',
    'reconcile',
    'pause',
    'resume',
    'revalidate',
    'receipt',
    'submit',
    'configure',
    ...PIPELINE_V2_ONLY_COMMANDS
  ].map((command) => [
    `pipeline ${command}`,
    async (ctx: HandlerContext) => {
      let params: unknown
      const apiVersion = ctx.flags.has('api-version')
        ? getRequiredStringFlag(ctx.flags, 'api-version')
        : '1'
      if (apiVersion === '2' || PIPELINE_V2_ONLY_COMMANDS.some((value) => value === command)) {
        return handlePipelineV2(command, ctx)
      }
      if (apiVersion !== '1') {
        throw new RuntimeClientError('invalid_argument', 'Unsupported pipeline API version')
      }
      if (command === 'submit') {
        params = PipelineSubmitParams.parse({
          id: getRequiredStringFlag(ctx.flags, 'id'),
          mutation: await input(ctx)
        })
      } else if (command === 'configure') {
        params = PipelineConfigureParams.parse(await input(ctx))
      } else if (['pause', 'resume', 'revalidate', 'receipt'].includes(command)) {
        params = (command === 'receipt' ? PipelineReceiptParams : PipelineControlParams).parse({
          id: getRequiredStringFlag(ctx.flags, 'id'),
          requestId: getRequiredStringFlag(ctx.flags, 'request-id'),
          expectedRevision: Number(getRequiredStringFlag(ctx.flags, 'expected-revision')),
          ...(ctx.flags.has('runtime-id')
            ? { expectedRuntimeId: getRequiredStringFlag(ctx.flags, 'runtime-id') }
            : {}),
          ...(command === 'receipt' ? { kind: getRequiredStringFlag(ctx.flags, 'kind') } : {})
        })
      } else if (['status', 'context', 'reconcile'].includes(command)) {
        params = {
          id: getRequiredStringFlag(ctx.flags, 'id'),
          ...(command === 'context' && ctx.flags.has('artifact-stage')
            ? { artifactStage: getRequiredStringFlag(ctx.flags, 'artifact-stage') }
            : {}),
          ...(command === 'context' && ctx.flags.has('artifact-index')
            ? { artifactIndex: Number(getRequiredStringFlag(ctx.flags, 'artifact-index')) }
            : {}),
          ...(command === 'reconcile' && ctx.flags.has('setup-terminal')
            ? { setupTerminal: getRequiredStringFlag(ctx.flags, 'setup-terminal') }
            : {})
        }
      }
      const response = await ctx.client.call<unknown>(`pipeline.${command}`, params)
      printResult(response, ctx.json, (value) => JSON.stringify(value, null, 2))
    }
  ])
)
