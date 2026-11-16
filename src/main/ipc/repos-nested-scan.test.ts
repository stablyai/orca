import type * as RepoDetectionModule from '../git/repositories/discovery/repo-detection'
import type * as GitExecFileModule from '../git/command-runner/git-exec-file'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as GitSpawnModule from '../git/command-runner/git-spawn'

const { reposMocks, moduleMocks, gitRepoProbeMocks } = await vi.hoisted(async () => {
  const moduleMocks = await import('./repos-remote-test-harness')
  return {
    reposMocks: moduleMocks.createReposIpcMocks(),
    moduleMocks,
    gitRepoProbeMocks: moduleMocks.createGitRepoProbeMocks()
  }
})

vi.mock('../git/repositories/discovery/repo-detection', async (importOriginal) =>
  moduleMocks.repoDetectionModuleMock(
    await importOriginal<typeof RepoDetectionModule>(),
    gitRepoProbeMocks
  )
)

vi.mock('../git/command-runner/git-exec-file', async (importOriginal) => {
  return {
    ...(await importOriginal<typeof GitExecFileModule>()),
    gitExecFileAsync: reposMocks.gitExecFileAsyncMock
  }
})

vi.mock('electron', () => moduleMocks.electronModuleMock(reposMocks))
vi.mock('../git/repositories/repository-name', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getRepoName: vi.fn().mockImplementation((path: string) => path.split('/').pop())
}))
vi.mock('../git/refs/resolution/repo-default-base-ref', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getDefaultBaseRefAsync: vi.fn().mockResolvedValue('origin/main')
}))
vi.mock('../git/remotes/repo-remote-queries', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getRemoteCount: vi.fn().mockResolvedValue(1)
}))
vi.mock('../git/refs/resolution/repo-base-ref-search', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  searchBaseRefs: vi.fn().mockResolvedValue([])
}))
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
import { getGitRepoRoot, isGitRepo } from '../git/repositories/discovery/repo-detection'
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

    registerRepoHandlers(mockWindow as never, mockStore as never, {} as never)
  })

  it('returns partial local scan results after cancellation', async () => {
    vi.mocked(isGitRepo).mockReturnValue(false)
    const root = await mkdtemp(join(tmpdir(), 'orca-nested-local-cancel-'))
    try {
      await mkdir(join(root, 'api', '.git'), { recursive: true })
      await mkdir(join(root, 'web', '.git'), { recursive: true })
      const event = {
        sender: {
          send: vi.fn((_channel: string, data: { scanId: string; scan: { repos: unknown[] } }) => {
            if (data.scan.repos.length === 1) {
              handlers.get('projectGroups:cancelNestedScan')!(null, { scanId: data.scanId })
            }
          })
        }
      }

      const result = await handlers.get('projectGroups:scanNested')!(event, {
        path: root,
        scanId: 'local-scan-1'
      })

      expect(result).toMatchObject({
        selectedPath: root,
        selectedPathKind: 'non_git_folder',
        stopped: true,
        repos: [{ path: join(root, 'api') }]
      })
      expect(event.sender.send).toHaveBeenCalledWith(
        'projectGroups:scanNestedProgress',
        expect.objectContaining({ scanId: 'local-scan-1' })
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
