import { expect, it } from 'vitest'
import { preparePipelineCreation } from '../pipeline-workspace-creation'
import { storeRepo } from '../testing/pipeline-runtime-store.test-fixture'
import type { RuntimeManagedWorktreeCreateArgs } from '../../workspaces/creation/runtime-managed-worktree-create-types'

it('rejects_a_changed_runtime_before_reading_service_or_creating_a_workspace', async () => {
  const runtime = {
    getRuntimeId: () => 'different-runtime',
    get pipelineRuntime(): never {
      throw new Error('No pipeline effect should be reached')
    },
    showManagedWorktree: async (): Promise<never> => {
      throw new Error('No workspace lookup should be reached')
    }
  }
  const args: RuntimeManagedWorktreeCreateArgs = {
    repoSelector: 'id:project-1',
    name: 'New task',
    pipeline: {
      profile: {
        engineVersion: 2,
        projectId: 'project-1',
        id: 'custom',
        version: '1',
        digest: 'a'.repeat(64)
      },
      task: 'Preserve this task',
      expectedRuntimeId: 'admitted-runtime'
    }
  }
  await expect(
    preparePipelineCreation(
      runtime,
      args,
      storeRepo({
        id: 'project-1',
        path: '/project',
        kind: 'git'
      })
    )
  ).rejects.toThrow('pipeline_runtime_identity_changed')
})
