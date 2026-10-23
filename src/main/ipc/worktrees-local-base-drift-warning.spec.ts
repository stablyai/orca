import { expect, it } from 'vitest'
import {
  addWorktreeMock,
  listWorktreesMock,
  computeWorktreePathMock,
  gitExecFileAsyncMock
} from './worktrees-test-module-mocks'
import { handlers, harnessRepo, store } from './worktrees-test-harness'
import type { WorktreeRuntimeStub } from './worktrees-test-runtime-stub'

export function registerLocalBaseDriftWarningTest(runtime: () => WorktreeRuntimeStub): void {
  it('reports stale local base drift through the desktop create path', async () => {
    store.getRepo.mockReturnValue({ ...harnessRepo, worktreeBaseRef: 'develop' })
    runtime().resolveRemoteTrackingBase.mockResolvedValue(null)
    listWorktreesMock.mockResolvedValue([
      {
        path: '/workspace/local-stale-base',
        head: 'created-sha',
        branch: 'local-stale-base',
        isBare: false,
        isMainWorktree: false
      }
    ])
    computeWorktreePathMock.mockReturnValue('/workspace/local-stale-base')
    gitExecFileAsyncMock.mockImplementation(async (args) => {
      if (args[0] === 'rev-list') {
        return { stdout: '0\t692\n', stderr: '' }
      }
      if (args.includes('refs/heads/develop^{commit}')) {
        return { stdout: 'develop-sha\n', stderr: '' }
      }
      return { stdout: '', stderr: '' }
    })

    const result = await handlers['worktrees:create'](null, {
      repoId: 'repo-1',
      name: 'local-stale-base'
    })

    expect(addWorktreeMock).toHaveBeenCalledWith(
      '/workspace/repo',
      '/workspace/local-stale-base',
      'local-stale-base',
      'develop',
      false,
      false,
      {}
    )
    expect(result).toMatchObject({
      localBaseRefDriftWarning: {
        baseRef: 'develop',
        defaultBaseRef: 'origin/main',
        ahead: 0,
        behind: 692,
        relation: 'behind'
      },
      warning: expect.stringContaining('develop is 692 commit(s) behind origin/main')
    })
  })
}
