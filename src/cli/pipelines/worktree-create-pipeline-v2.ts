import type { HandlerContext } from '../dispatch/dispatch'
import { getRequiredStringFlag, getOptionalStringFlag } from '../arguments/flags'
import { RuntimeClientError } from '../runtime/connection/types'
import { PipelineV2Task } from '../../shared/pipelines/v2/pipeline-v2-contracts'
import { PipelineV2TemplateSelection } from '../../shared/pipelines/v2/pipeline-v2-template-contracts'
import { readPipelineText } from './pipeline-input-json'

export async function readWorktreePipelineV2(ctx: HandlerContext, id: string, creationId: string) {
  const projectId = getRequiredStringFlag(ctx.flags, 'pipeline-project-id')
  const literal = ctx.flags.has('pipeline-task')
  const file = ctx.flags.has('pipeline-task-file')
  if (literal === file) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Choose --pipeline-task or --pipeline-task-file'
    )
  }
  const task = PipelineV2Task.parse(
    literal
      ? getRequiredStringFlag(ctx.flags, 'pipeline-task')
      : await readPipelineText(
          {
            ...ctx,
            flags: new Map([['input-file', getRequiredStringFlag(ctx.flags, 'pipeline-task-file')]])
          },
          65536,
          true
        )
  )
  const expectedRuntimeId = getOptionalStringFlag(ctx.flags, 'pipeline-runtime-id')
  let cursor = 0
  for (let page = 0; page < 4; page++) {
    const response = await ctx.client.call<{
      contractVersion: 2
      profiles: { id: string; projectId: string; version: string; digest: string }[]
      cursor?: number
      hasMore?: boolean
    }>('pipeline.v2.profiles', {
      projectId,
      cursor,
      limit: 50,
      ...(expectedRuntimeId ? { expectedRuntimeId } : {})
    })
    if (
      response.result.contractVersion !== 2 ||
      !response._meta.runtimeId ||
      (expectedRuntimeId && response._meta.runtimeId !== expectedRuntimeId)
    ) {
      throw new RuntimeClientError(
        'incompatible_runtime',
        'Pipeline v2 runtime identity or capability changed'
      )
    }
    const selected = response.result.profiles.find((profile) => profile.id === id)
    if (selected) {
      if (selected.projectId !== projectId) {
        throw new RuntimeClientError('incompatible_runtime', 'Pipeline project changed')
      }
      return {
        creationId,
        pipeline: {
          profile: PipelineV2TemplateSelection.parse({
            engineVersion: 2,
            projectId,
            id: selected.id,
            version: selected.version,
            digest: selected.digest
          }),
          task,
          expectedRuntimeId: response._meta.runtimeId
        }
      }
    }
    if (!response.result.hasMore) {
      break
    }
    const next = response.result.cursor
    if (!Number.isSafeInteger(next) || next! <= cursor) {
      throw new RuntimeClientError('incompatible_runtime', 'Pipeline profile cursor is invalid')
    }
    cursor = next!
  }
  throw new RuntimeClientError(
    'invalid_argument',
    'Pipeline template is not enabled in this project'
  )
}
