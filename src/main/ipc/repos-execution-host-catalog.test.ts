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

  it('rejects malformed local project group create arguments before persistence', () => {
    expect(() =>
      handlers.get('projectGroups:create')!(null, { name: 123, createdFrom: 'unexpected' })
    ).toThrow('invalid_project_group_create_args')

    expect(mockStore.createProjectGroup).not.toHaveBeenCalled()
  })

  it('rejects malformed local project group update arguments before persistence', () => {
    expect(() =>
      handlers.get('projectGroups:update')!(null, {
        groupId: 'group-1',
        updates: { isCollapsed: 'yes' }
      })
    ).toThrow('invalid_project_group_update_args')

    expect(mockStore.updateProjectGroup).not.toHaveBeenCalled()
  })

  it('moves the twin on the host the renderer named, not the first row with the id', () => {
    const localRow = { id: 'dup', path: '/laptop/dup', executionHostId: 'local' }
    mockStore.getRepo.mockReturnValue(localRow)
    mockStore.moveProjectToGroup.mockReturnValue({ id: 'dup', connectionId: 'ssh-1' })

    handlers.get('projectGroups:moveProject')!(null, {
      projectId: 'dup',
      groupId: 'group-1',
      hostId: 'ssh:ssh-1'
    })

    expect(mockStore.moveProjectToGroup).toHaveBeenCalledWith(
      { id: 'dup', executionHostId: 'ssh:ssh-1' },
      'group-1',
      undefined
    )
  })

  it('keeps moving the first row with the id for a caller that names no host', () => {
    const localRow = { id: 'dup', path: '/laptop/dup', executionHostId: 'local' }
    mockStore.getRepo.mockReturnValue(localRow)

    handlers.get('projectGroups:moveProject')!(null, { projectId: 'dup', groupId: null })

    expect(mockStore.moveProjectToGroup).toHaveBeenCalledWith(localRow, null, undefined)
  })

  it('rejects an invalid host id before persistence', () => {
    expect(() =>
      handlers.get('projectGroups:moveProject')!(null, {
        projectId: 'dup',
        groupId: null,
        hostId: 'not a host'
      })
    ).toThrow('invalid_project_group_move_repo_args')

    expect(mockStore.moveProjectToGroup).not.toHaveBeenCalled()
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
