import { randomUUID } from 'node:crypto'
import { PipelineStart, type PipelineRun } from '../../../shared/pipelines/pipeline-contracts'
import { isFolderRepo } from '../../../shared/repository/repo-kind'
import { getRepoExecutionHostId } from '../../../shared/execution-host/execution-host'
import { isWslUncPath } from '../../../shared/file-access/wsl-paths'
import type { Repo } from '../../../shared/repository/repo-types'
import type { Worktree } from '../../../shared/worktree/types'
import type { CreateWorktreeResult } from '../../../shared/worktree/create-types'
import type { RuntimeManagedWorktreeCreateArgs } from '../workspaces/creation/runtime-managed-worktree-create-types'
import type { OrcaRuntimeService } from '../orca-runtime'
import type { PipelineRuntime } from './pipeline-runtime'
import { preparePipelineV2Creation } from './v2/pipeline-v2-workspace-creation'
import { bindAdmittedPipelineV2 } from './v2/pipeline-v2-admitted-run'
import { suppressPipelineStartup } from './pipeline-creation-startup'
import { commandPipelineV2 } from './v2/pipeline-v2-execution'

export async function preparePipelineCreation(
  runtime: Pick<OrcaRuntimeService, 'pipelineRuntime' | 'showManagedWorktree'> &
    Partial<Pick<OrcaRuntimeService, 'getRuntimeId'>>,
  args: RuntimeManagedWorktreeCreateArgs,
  repo: Repo
): Promise<{ args: RuntimeManagedWorktreeCreateArgs; replay?: CreateWorktreeResult }> {
  if (!args.pipeline) {
    return { args }
  }
  const pipeline = PipelineStart.parse(args.pipeline)
  if (pipeline.expectedRuntimeId && runtime.getRuntimeId?.() !== pipeline.expectedRuntimeId) {
    throw new Error('pipeline_runtime_identity_changed')
  }
  if (isFolderRepo(repo) || getRepoExecutionHostId(repo) !== 'local' || isWslUncPath(repo.path)) {
    throw new Error('pipeline_local_git_only')
  }
  const service = runtime.pipelineRuntime
  const creationId = args.creationId ?? randomUUID()
  const payload = {
    repo: repo.id,
    name: args.name,
    baseBranch: args.baseBranch,
    branchNameOverride: args.branchNameOverride,
    branchIntent: args.branchIntent,
    setupDecision: args.setupDecision,
    pipeline
  }
  if ('engineVersion' in pipeline.profile) {
    return preparePipelineV2Creation(
      runtime,
      args,
      repo,
      pipeline.profile,
      pipeline.task,
      creationId,
      payload
    )
  }
  let admission: { fresh: boolean; run?: PipelineRun } | undefined = await service.store.creation(
    creationId,
    payload
  )
  if (!admission) {
    const { definition, checks } = await service.validateSelection(pipeline.profile, repo.id)
    admission = await service.store.reserveCreation(creationId, payload, {
      profile: definition.profile,
      provider: definition.provider,
      checkSnapshot: checks
    })
  }
  if (!admission.fresh) {
    if (!admission.run) {
      throw new Error('pipeline_create_reconciliation_required')
    }
    await service.assertWorkspace(admission.run.workspace)
    return {
      args,
      replay: {
        worktree: await runtime.showManagedWorktree(`id:${admission.run.workspace.id}`, 'local')
      }
    }
  }
  return { args: suppressPipelineStartup(args, pipeline, creationId) }
}

export async function bindCreatedPipeline(
  runtime: Pick<OrcaRuntimeService, 'pipelineRuntime'>,
  args: RuntimeManagedWorktreeCreateArgs,
  worktree: Worktree,
  save: (pipeline: Worktree['pipeline']) => void
) {
  if (!args.pipeline) {
    return undefined
  }
  const service = runtime.pipelineRuntime
  if ('engineVersion' in args.pipeline.profile) {
    if (!args.creationId) {
      throw new Error('pipeline_creation_snapshot_missing')
    }
    const profile = args.pipeline.profile
    const run = await bindAdmittedPipelineV2(
      service.store,
      worktree,
      profile,
      args.pipeline.task,
      args.creationId
    )
    worktree.pipeline = {
      engineVersion: 2,
      runId: run.id,
      projectId: profile.projectId,
      profileId: profile.id,
      version: profile.version,
      digest: profile.digest
    }
    save(worktree.pipeline)
    await service.store.completeCreationV2(args.creationId, run.id)
    return run
  }
  const run = await service.bind(
    worktree,
    args.pipeline.profile,
    args.pipeline.task,
    `create:${args.creationId}`
  )
  worktree.pipeline = {
    runId: run.id,
    profileId: args.pipeline.profile.id,
    version: args.pipeline.profile.version,
    digest: args.pipeline.profile.digest
  }
  save(worktree.pipeline)
  await service.store.completeCreation(args.creationId!, run.id)
  return run
}

export async function settlePipelineCreationSetup(
  service: PipelineRuntime,
  id: string,
  setup: { setupTrustMismatch?: unknown; shouldRunSetup: boolean },
  terminal: string | null
): Promise<void> {
  if (await service.store.hasV2(id)) {
    if (setup.setupTrustMismatch || (setup.shouldRunSetup && !terminal)) {
      await commandPipelineV2(service.store, id, {
        kind: 'uncertain',
        reason: 'Setup approval or startup needs owner reconciliation'
      })
    } else if (terminal) {
      await commandPipelineV2(service.store, id, { kind: 'setup_wait', terminalHandle: terminal })
      service.observeSetup(id, terminal)
    } else {
      await service.releaseSetup(id)
    }
    return
  }
  const run = await service.store.get(id)
  if (setup.setupTrustMismatch || (setup.shouldRunSetup && !terminal)) {
    await service.store.command(id, {
      requestId: `setup-unknown:${id}`,
      expectedRevision: run.revision,
      command: { kind: 'uncertain', reason: 'Setup approval or startup needs owner reconciliation' }
    })
  } else if (terminal) {
    await service.store.command(id, {
      requestId: `setup-observer:${id}`,
      expectedRevision: run.revision,
      command: { kind: 'setup_wait', terminalHandle: terminal }
    })
    service.observeSetup(id, terminal)
  } else {
    await service.releaseSetup(id)
  }
}
