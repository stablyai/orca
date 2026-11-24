import {
  PipelineDefinitionSnapshot,
  type PipelineSelection
} from '../../../shared/pipelines/pipeline-contracts'
import type { Worktree } from '../../../shared/worktree/types'
import type { PipelineStore } from './pipeline-store'
import { pipelineDigest } from './pipeline-store'
import { pipelineCommit } from './pipeline-evidence'

export async function bindAdmittedPipeline(
  store: PipelineStore,
  worktree: Pick<Worktree, 'id' | 'instanceId' | 'repoId' | 'path'>,
  selection: PipelineSelection,
  task: string,
  requestId: string
) {
  const snapshot = PipelineDefinitionSnapshot.parse(
    store.creationSnapshot(requestId.replace(/^create:/, ''))
  )
  if (
    selection.digest !== pipelineDigest(snapshot.profile) ||
    selection.version !== snapshot.profile.version ||
    selection.id !== `${snapshot.provider.pluginKey}/${snapshot.profile.id}`
  ) {
    throw new Error('pipeline_creation_snapshot_mismatch')
  }
  if (!worktree.instanceId) {
    throw new Error('pipeline_workspace_instance_missing')
  }
  return store.create({
    requestId,
    waitForSetup: true,
    profile: snapshot.profile,
    provider: snapshot.provider,
    checkSnapshot: snapshot.checkSnapshot,
    baseCommit: await pipelineCommit(worktree.path),
    task,
    workspace: {
      id: worktree.id,
      instanceId: worktree.instanceId,
      projectId: worktree.repoId,
      hostId: 'local',
      path: worktree.path
    }
  })
}
