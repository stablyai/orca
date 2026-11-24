import type { OrcaRuntimeService } from '../../orca-runtime'
import type { RuntimeManagedWorktreeCreateArgs } from '../../workspaces/creation/runtime-managed-worktree-create-types'
import type { Repo } from '../../../../shared/repository/repo-types'
import type { PipelineV2TemplateSelection } from '../../../../shared/pipelines/v2/pipeline-v2-template-contracts'
import { suppressPipelineStartup } from '../pipeline-creation-startup'

export async function preparePipelineV2Creation(
  runtime: Pick<OrcaRuntimeService, 'pipelineRuntime' | 'showManagedWorktree'>,
  args: RuntimeManagedWorktreeCreateArgs,
  repo: Repo,
  profile: PipelineV2TemplateSelection,
  task: string,
  creationId: string,
  payload: unknown
) {
  const service = runtime.pipelineRuntime
  const previous = service.store.creationV2(creationId, payload)
  if (previous) {
    if (!previous.run) {
      throw new Error('pipeline_create_reconciliation_required')
    }
    await service.assertWorkspace(previous.run.workspace)
    return {
      args,
      replay: {
        worktree: await runtime.showManagedWorktree(`id:${previous.run.workspace.id}`, 'local')
      }
    }
  }
  const admission = await service.admitV2(profile, task, creationId, payload, repo)
  if (!admission.fresh) {
    throw new Error('pipeline_create_reconciliation_required')
  }
  return { args: suppressPipelineStartup(args, { profile, task }, creationId) }
}
