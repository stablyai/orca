import { afterEach, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime'
import { partialRuntimeStore } from './testing/pipeline-runtime-store.test-fixture'
import type { Repo } from '../../../shared/repository/repo-types'

afterEach(() => vi.restoreAllMocks())
it.each([
  { kind: 'folder', executionHostId: 'local' },
  { kind: 'git', executionHostId: 'ssh:remote' },
  { kind: 'git', executionHostId: 'runtime:remote' }
] as const)(
  'refuses an unsupported selected pipeline target before creating or starting anything ($kind/$executionHostId)',
  async (target) => {
    const repo: Repo = {
      id: 'repo',
      path: '/project',
      displayName: 'Project',
      addedAt: 0,
      badgeColor: '',
      ...target
    }
    const runtime = new OrcaRuntimeService(
      partialRuntimeStore({
        getRepos: () => [repo],
        getRepo: () => repo,
        getSettings: () => ({}),
        getAllWorktreeMeta: () => ({}),
        getWorktreeMeta: () => undefined
      })
    )
    const launch = vi
      .spyOn(runtime, 'createTerminal')
      .mockRejectedValue(new Error('unexpected launch'))
    await expect(
      runtime.createManagedWorktree({
        repoSelector: 'id:repo',
        name: 'task',
        pipeline: {
          profile: { id: 'sample/standard', version: '1', digest: 'a'.repeat(64) },
          task: 'Fix delivery'
        }
      })
    ).rejects.toThrow('pipeline_local_git_only')
    expect(launch).not.toHaveBeenCalled()
  }
)
