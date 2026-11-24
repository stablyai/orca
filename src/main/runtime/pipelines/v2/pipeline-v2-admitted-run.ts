import type { PipelineStore } from '../pipeline-store'
import type { Worktree } from '../../../../shared/worktree/types'
import { PipelineV2CreationSnapshot } from '../../../../shared/pipelines/v2/pipeline-v2-admission-contracts'
import { PipelineV2TemplateSelection } from '../../../../shared/pipelines/v2/pipeline-v2-template-contracts'
import { PipelineV2Task } from '../../../../shared/pipelines/v2/pipeline-v2-contracts'
import { pipelineV2Fingerprint } from '../../../../shared/pipelines/v2/pipeline-v2-fingerprint'
import { pipelineCommit, pipelineSourceRevision } from '../pipeline-evidence'

export async function bindAdmittedPipelineV2(
  store: PipelineStore,
  worktree: Pick<Worktree, 'id' | 'instanceId' | 'repoId' | 'path'>,
  rawSelection: unknown,
  rawTask: unknown,
  creationId: string,
  ports = { sourceRevision: pipelineSourceRevision, commit: pipelineCommit }
) {
  const selection = PipelineV2TemplateSelection.parse(rawSelection)
  const task = PipelineV2Task.parse(rawTask)
  const snapshot = PipelineV2CreationSnapshot.parse(store.creationSnapshotV2(creationId))
  if (
    pipelineV2Fingerprint(selection) !== pipelineV2Fingerprint(snapshot.selection) ||
    task !== snapshot.task ||
    worktree.repoId !== selection.projectId
  ) {
    throw new Error('pipeline_creation_snapshot_mismatch')
  }
  if (!worktree.instanceId) {
    throw new Error('pipeline_workspace_instance_missing')
  }
  const workspace = {
    id: worktree.id,
    instanceId: worktree.instanceId,
    projectId: worktree.repoId,
    path: worktree.path,
    hostId: 'local' as const
  }
  const key = pipelineV2Fingerprint({ creationId })
  return store.createV2({
    id: `v2:${key.slice(0, 48)}`,
    requestId: `create:${key}`,
    workspace,
    definition: snapshot.definition,
    task: snapshot.task,
    effectiveExecutors: snapshot.effectiveExecutors,
    checkSnapshot: snapshot.checkSnapshot,
    waitForSetup: true,
    baseCommit: await ports.commit(worktree.path),
    sourceRevision: await ports.sourceRevision(workspace)
  })
}
