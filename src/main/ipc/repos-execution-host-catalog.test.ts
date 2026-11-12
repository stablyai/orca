import type * as RepoDetectionModule from '../git/repositories/discovery/repo-detection'
import type * as GitExecFileModule from '../git/command-runner/git-exec-file'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { wslMoveCutoverFixture as cutover } from '../persistence/__fixtures__/wsl-mover/wsl-move-cutover-fixture'
import { seedWslMoveCutover } from '../persistence/__fixtures__/wsl-mover/wsl-move-journal-seeding'
import {
  WslMoveProjectFencedError,
  loadWslMoveFence,
  resetWslMoveFenceForTests
} from '../persistence/moving-wsl-projects/quiescence/wsl-move-scope-guard'

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

  describe('while a WSL move fences the local repo-1', () => {
    let userDataPath: string
    beforeEach(() => {
      userDataPath = mkdtempSync(join(tmpdir(), 'wsl-move-project-group-ipc-'))
      loadWslMoveFence(userDataPath)
      seedWslMoveCutover(userDataPath, cutover('move-1', 'source-fenced'))
    })
    afterEach(() => {
      resetWslMoveFenceForTests()
      rmSync(userDataPath, { recursive: true, force: true })
    })

    it('still moves the SSH twin, which the move does not take', () => {
      handlers.get('projectGroups:moveProject')!(null, {
        projectId: 'repo-1',
        groupId: 'group-1',
        hostId: 'ssh:ssh-1'
      })

      expect(mockStore.moveProjectToGroup).toHaveBeenCalledWith(
        { id: 'repo-1', executionHostId: 'ssh:ssh-1' },
        'group-1',
        undefined
      )
    })

    it('refuses the local twin', () => {
      expect(() =>
        handlers.get('projectGroups:moveProject')!(null, {
          projectId: 'repo-1',
          groupId: 'group-1',
          hostId: 'local'
        })
      ).toThrow(WslMoveProjectFencedError)
      expect(mockStore.moveProjectToGroup).not.toHaveBeenCalled()
    })
  })
})
