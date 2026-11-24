import type { HandlerContext } from '../dispatch/dispatch'
import { getOptionalStringFlag, getRequiredStringFlag } from '../arguments/flags'
import { RuntimeClientError } from '../runtime/connection/types'
import type { PipelineSelection } from '../../shared/pipelines/pipeline-contracts'
import { readWorktreePipelineV2 } from './worktree-create-pipeline-v2'

export async function readWorktreePipeline(context: HandlerContext, agent?: string) {
  const { flags, client } = context
  const id = getOptionalStringFlag(flags, 'pipeline')
  if (!id) {
    return undefined
  }
  if (agent) {
    throw new RuntimeClientError(
      'invalid_argument',
      '--pipeline owns agent selection; omit --agent'
    )
  }
  const creationId = getRequiredStringFlag(flags, 'request-id')
  const apiVersion = getOptionalStringFlag(flags, 'api-version') ?? '1'
  if (apiVersion === '2') {
    return readWorktreePipelineV2(context, id, creationId)
  }
  if (apiVersion !== '1') {
    throw new RuntimeClientError('invalid_argument', 'Unsupported pipeline API version')
  }
  const { result } = await client.call<{ profiles: PipelineSelection[] }>('pipeline.profiles')
  const selected = result.profiles.find((profile) => profile.id === id)
  if (!selected) {
    throw new RuntimeClientError('invalid_argument', 'Pipeline profile is not enabled')
  }
  return {
    creationId,
    pipeline: {
      profile: { id: selected.id, version: selected.version, digest: selected.digest },
      task: [getRequiredStringFlag(flags, 'name'), getOptionalStringFlag(flags, 'comment')]
        .filter(Boolean)
        .join('\n')
    }
  }
}
