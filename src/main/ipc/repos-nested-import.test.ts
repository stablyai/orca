import type * as RepoDetectionModule from '../git/repo-detection'
import type * as GitExecFileModule from '../git/command-runner/git-exec-file'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as GitSpawnModule from '../git/command-runner/git-spawn'
import type * as RepoModule from '../git/repo'

const { reposMocks, moduleMocks, gitRepoProbeMocks } = await vi.hoisted(async () => {
  const moduleMocks = await import('./repos-remote-test-harness')
  return {
    reposMocks: moduleMocks.createReposIpcMocks(),
    moduleMocks,
    gitRepoProbeMocks: moduleMocks.createGitRepoProbeMocks()
  }
})

vi.mock('../git/repo-detection', async (importOriginal) => {
  return {
    ...(await importOriginal<typeof RepoDetectionModule>()),
    isGitRepoAsync: gitRepoProbeMocks.isGitRepo,
    getGitRepoRootAsync: gitRepoProbeMocks.getGitRepoRoot
  }
})

vi.mock('../git/command-runner/git-exec-file', async (importOriginal) => {
  return {
    ...(await importOriginal<typeof GitExecFileModule>()),
    gitExecFileAsync: reposMocks.gitExecFileAsyncMock
  }
})

vi.mock('electron', () => moduleMocks.electronModuleMock(reposMocks))
vi.mock('../git/repo', async (importOriginal) =>
  moduleMocks.gitRepoModuleMock(await importOriginal<typeof RepoModule>(), gitRepoProbeMocks)
)
vi.mock('../git/command-runner/git-spawn', async (importOriginal) =>
  moduleMocks.gitSpawnModuleMock(reposMocks, await importOriginal<typeof GitSpawnModule>())
)
vi.mock('../git/worktrees/catalog/worktree-scan-cache', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listWorktreeGraph: reposMocks.listWorktreeGraphMock
}))
vi.mock('./worktrees/removal/registered-worktree-roots-cache', () =>
  moduleMocks.registeredWorktreeRootsCacheModuleMock(reposMocks)
)
vi.mock('../workspaces/creation/worktree-root-preparation', () =>
  moduleMocks.worktreeRootPreparationModuleMock(reposMocks)
)

import { registerRepoHandlers } from './repos'
import { clearGitCapabilityStateForTests } from '../git/command-runner/host-routing/git-capability-state'
import { resetSshProviderAuthorities } from '../ssh/connection/authority/ssh-provider-authority'
import { getGitRepoRoot, isGitRepo } from '../git/repo'
import { createRepoHandlerHarness, resetProjectGroupMocks } from './repos-remote-test-harness'

const { handleMock, mockStore } = reposMocks

beforeEach(() => {
  clearGitCapabilityStateForTests()
  resetSshProviderAuthorities()
})

describe('projectGroups IPC validation', () => {
  const { handlers, mockWindow, captureHandlers } = createRepoHandlerHarness()

  beforeEach(() => {
    captureHandlers(handleMock)
    mockWindow.webContents.send.mockReset()
    resetProjectGroupMocks(reposMocks, { isGitRepo, getGitRepoRoot })

    registerRepoHandlers(
      mockWindow as never,
      mockStore as never,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: These IPC cases use only the metadata owner's enqueue method; other runtime handlers are not invoked.
      {
        repositoryForkBackfill: {
          enqueue: vi.fn().mockResolvedValue(undefined),
          resolve: vi.fn().mockResolvedValue(true)
        }
      } as never
    )
  })

  const group = {
    id: 'group-1',
    name: 'Platform',
    parentPath: '/srv/platform',
    parentGroupId: null,
    createdFrom: 'folder-scan',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1
  }

  async function withNestedTree(
    repoDirs: string[],
    run: (root: string) => Promise<void>
  ): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), 'orca-nested-import-'))
    try {
      for (const dir of repoDirs) {
        await mkdir(join(root, dir, '.git'), { recursive: true })
      }
      vi.mocked(isGitRepo).mockImplementation((path: string) => path !== root)
      await run(root)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }

  it('does not reuse a completed nested scan id for a different parent path', async () => {
    mockStore.createProjectGroup.mockReturnValue(group)
    await withNestedTree([join('platform', 'api'), join('other', 'api')], async (root) => {
      await handlers.get('projectGroups:scanNested')!(
        { sender: { send: vi.fn() } },
        { path: join(root, 'platform'), scanId: 'scan-parent-context' }
      )
      mockStore.addRepo.mockClear()

      const result = await handlers.get('projectGroups:importNested')!(null, {
        parentPath: join(root, 'other'),
        groupName: 'Other',
        projectPaths: [join(root, 'platform', 'api')],
        scanId: 'scan-parent-context',
        mode: 'group'
      })

      expect(result).toMatchObject({
        importedCount: 0,
        failedCount: 1,
        projects: [{ errorCode: 'not_in_scan' }]
      })
      expect(mockStore.addRepo).not.toHaveBeenCalled()
    })
  })

  it('refuses nested imports on an SSH target and never inspects the path locally', async () => {
    await expect(
      handlers.get('projectGroups:importNested')!(null, {
        parentPath: '/srv/platform',
        groupName: 'Platform',
        projectPaths: ['/srv/platform/api'],
        connectionId: 'conn-1',
        mode: 'group'
      })
    ).rejects.toThrow('ssh_connection_unavailable')

    expect(mockStore.addRepo).not.toHaveBeenCalled()
    expect(isGitRepo).not.toHaveBeenCalled()
  })
})
