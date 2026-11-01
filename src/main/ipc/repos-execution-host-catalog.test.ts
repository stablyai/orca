import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as GitRunner from '../git/runner'
import type * as RepoModule from '../git/repo'

const { reposMocks, moduleMocks } = await vi.hoisted(async () => {
  const moduleMocks = await import('./repos-remote-test-harness')
  return { reposMocks: moduleMocks.createReposIpcMocks(), moduleMocks }
})

vi.mock('electron', () => moduleMocks.electronModuleMock(reposMocks))
vi.mock('../git/repo', async (importOriginal) =>
  moduleMocks.gitRepoModuleMock(await importOriginal<typeof RepoModule>())
)
vi.mock('../git/runner', async (importOriginal) =>
  moduleMocks.gitRunnerModuleMock(reposMocks, await importOriginal<typeof GitRunner>())
)
vi.mock('../git/worktree', () => moduleMocks.gitWorktreeModuleMock(reposMocks))
vi.mock('./registered-worktree-roots-cache', () =>
  moduleMocks.registeredWorktreeRootsCacheModuleMock(reposMocks)
)
vi.mock('../worktree-root-preparation', () =>
  moduleMocks.worktreeRootPreparationModuleMock(reposMocks)
)

import { registerRepoHandlers } from './repos'
import { clearGitCapabilityStateForTests } from '../git/git-capability-state'
import { resetSshProviderAuthorities } from '../ssh/ssh-provider-authority'
import { getGitRepoRoot, isGitRepo } from '../git/repo'
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
} from '../persistence/moving-wsl-projects/wsl-move-scope-guard'

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
