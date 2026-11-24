import { afterEach, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repository/repo-types'
import { OrcaRuntimeService } from '../../orca-runtime'
import { PipelineStore } from '../pipeline-store'
import { preparePipelineCreation } from '../pipeline-workspace-creation'
import { releasePipelineSetup } from '../pipeline-setup'
import { bindAdmittedPipelineV2 } from './pipeline-v2-admitted-run'
import { admitPipelineV2 } from './pipeline-v2-admission'
import type { PipelineV2LaunchEnvironment } from './pipeline-v2-launch'
import { pipelineV2TemplateFixture } from '../../../../shared/pipelines/v2/pipeline-v2.test-fixture'
import {
  partialRuntimeStore,
  storeWorktreeMeta
} from '../testing/pipeline-runtime-store.test-fixture'
import { mergeWorktree } from '../../../ipc/worktrees/metadata/worktree-metadata-merge'

const stores: PipelineStore[] = []
afterEach(() => {
  for (const store of stores.splice(0)) {
    store.close()
  }
  vi.restoreAllMocks()
})
it('lost_create_reply_returns_the_original_instance_and_keeps_startup_suppressed', async () => {
  const store = new PipelineStore(':memory:')
  stores.push(store)
  const repo: Repo = {
    id: 'project-1',
    path: '/project',
    displayName: 'Project',
    addedAt: 0,
    badgeColor: '',
    kind: 'git'
  }
  const runtime = new OrcaRuntimeService(
    partialRuntimeStore({ getRepo: () => repo, getRepos: () => [repo], getSettings: () => ({}) })
  )
  const launch: PipelineV2LaunchEnvironment = {
    settings: { agentPermissionDefault: 'own' },
    chatSupport: async () => ({ supported: true }),
    catalog: async () => ({
      origin: 'probe',
      fetchedAt: 1,
      models: [
        {
          id: 'fixture-model-a',
          label: 'Fixture A',
          isDefault: true,
          defaultEffort: 'high',
          efforts: [{ value: 'high', label: 'High' }]
        }
      ]
    })
  }
  const template = pipelineV2TemplateFixture()
  const saved = store.templatesV2.saveDraft({
    requestId: 'save',
    projectId: repo.id,
    expectedRevision: 0,
    draft: template
  })
  const { definition } = store.templatesV2.publish({
    requestId: 'publish',
    projectId: repo.id,
    draftId: saved.draftId,
    expectedRevision: saved.revision
  })
  const profile = {
    engineVersion: 2 as const,
    id: definition.id,
    projectId: repo.id,
    version: definition.version,
    digest: definition.digest
  }
  const task = 'Implement the cart discount'
  const service = {
    store,
    admitV2: (selection: unknown, text: string, creationId: string, payload: unknown) =>
      admitPipelineV2(
        { store, launch, project: { id: repo.id, path: repo.path, kind: 'git', hostId: 'local' } },
        selection,
        text,
        creationId,
        payload
      ),
    assertWorkspace: async (workspace: { instanceId: string }) => {
      if (workspace.instanceId !== 'instance-1') {
        throw new Error('pipeline_workspace_instance_changed')
      }
    }
  }
  Object.defineProperty(runtime, 'pipelineRuntime', { value: service })
  const args = {
    repoSelector: 'id:project-1',
    name: 'cart-task',
    creationId: 'creation-cart',
    pipeline: { profile, task },
    startupAgent: 'codex' as const,
    startupPrompt: 'This must be suppressed'
  }
  const first = await preparePipelineCreation(runtime, args, repo)
  expect(first.args).toMatchObject({
    setupOnly: true,
    promisedAgentChat: true,
    observeSetupCompletion: true
  })
  expect(first.args.startupAgent).toBeUndefined()
  expect(first.args.startupPrompt).toBeUndefined()
  const worktree = mergeWorktree(
    repo.id,
    {
      path: '/project/task',
      head: 'a'.repeat(40),
      branch: 'refs/heads/task',
      isBare: false,
      isMainWorktree: false
    },
    storeWorktreeMeta({ instanceId: 'instance-1', hostId: 'local' })
  )
  const run = await bindAdmittedPipelineV2(store, worktree, profile, task, args.creationId, {
    sourceRevision: async () => 'b'.repeat(64),
    commit: async () => 'a'.repeat(40)
  })
  store.completeCreationV2(args.creationId, run.id)
  vi.spyOn(runtime, 'showManagedWorktree').mockResolvedValue({
    ...worktree,
    linkedItems: worktree.linkedItems ?? [],
    parentWorktreeId: null,
    childWorktreeIds: [],
    lineage: null,
    workspaceLineage: null,
    git: worktree
  })
  const replay = await preparePipelineCreation(runtime, args, repo)
  expect(replay.replay?.worktree).toMatchObject({ id: worktree.id, instanceId: 'instance-1' })
  expect(store.getV2(run.id)).toMatchObject({
    state: 'waiting_setup',
    definitionDigest: profile.digest,
    task,
    workspace: { instanceId: 'instance-1' }
  })
  await releasePipelineSetup(store, run.id)
  expect(store.getV2(run.id)).toMatchObject({
    state: 'running',
    stageId: 'plan',
    usedInvocations: 0
  })
})
