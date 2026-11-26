import type { RpcContext } from '../../core'
import type { PipelineV2TemplateSaveParams } from '../../../../../shared/rpc-contract/pipeline-v2-params'
import { PipelineV2Template } from '../../../../../shared/pipelines/v2/pipeline-v2-contracts'
import { resolvePipeline } from '../../../pipelines/pipeline-profiles'
import {
  clonePipelineV1ToV2,
  codingPipelineV2Seed,
  researchPipelineV2Seed
} from '../../../pipelines/v2/pipeline-v2-seeds'
import { isFolderRepo } from '../../../../../shared/repository/repo-kind'
import { getRepoExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import { isWslUncPath } from '../../../../../shared/file-access/wsl-paths'
import { assertPipelineV2Runtime } from './pipeline-v2-scope'
import { lightPipelineV2Preset } from '../../../pipelines/v2/pipeline-v2-light-presets'

export function assertPipelineV2Project(
  ctx: RpcContext,
  projectId: string,
  expectedRuntimeId?: string
): void {
  assertPipelineV2Runtime(ctx, expectedRuntimeId)
  const repo = ctx.runtime.requireStore().getRepo(projectId)
  if (
    !repo ||
    isFolderRepo(repo) ||
    getRepoExecutionHostId(repo) !== 'local' ||
    isWslUncPath(repo.path)
  ) {
    throw new Error('pipeline_local_git_only')
  }
}
export async function pipelineV2DraftSource(
  ctx: RpcContext,
  input: Extract<PipelineV2TemplateSaveParams, { source: unknown }>
) {
  const source = input.source
  if (source.kind === 'seed') {
    const draft =
      source.seedId === 'coding'
        ? codingPipelineV2Seed(input.projectId)
        : source.seedId === 'research'
          ? researchPipelineV2Seed(input.projectId)
          : lightPipelineV2Preset(input.projectId, source.seedId)
    return {
      draft: { ...draft, id: input.id },
      provenance: { kind: 'seed' as const, seedId: source.seedId }
    }
  }
  if (source.kind === 'v1-clone') {
    const available = await resolvePipeline(source.profile)
    return {
      draft: { ...clonePipelineV1ToV2(available.profile, input.projectId), id: input.id },
      provenance: {
        kind: 'v1-clone' as const,
        profileId: source.profile.id,
        digest: source.profile.digest
      }
    }
  }
  const { definition } = await ctx.runtime.pipelineRuntime.store.templatesV2.getVersion(
    source.selection
  )
  const { digest: _digest, engineVersion: _engine, ...template } = definition
  return {
    draft: PipelineV2Template.parse({
      ...template,
      id: input.id,
      projectId: input.projectId,
      version: '1'
    }),
    provenance: { kind: 'copy' as const, source: source.selection }
  }
}
