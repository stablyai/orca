import { beforeEach, describe, expect, it, vi } from 'vitest'
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
vi.mock('../providers/ssh-git-dispatch', () => moduleMocks.sshGitDispatchModuleMock(reposMocks))
vi.mock('../providers/ssh-filesystem-dispatch', () =>
  moduleMocks.sshFilesystemDispatchModuleMock(reposMocks)
)
vi.mock('./ssh', () => moduleMocks.sshModuleMock(reposMocks))
vi.mock('../ssh/ssh-target-registry', () => moduleMocks.sshModuleMock(reposMocks))

import { registerRepoHandlers } from './repos'
import { clearGitCapabilityStateForTests } from '../git/git-capability-state'
import {
  getSshProviderAuthority,
  resetSshProviderAuthorities,
  rotateSshProviderAuthority
} from '../ssh/ssh-provider-authority'
import { getGitRepoRoot, isGitRepo } from '../git/repo'
import { toSshExecutionHostId } from '../../shared/execution-host'
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

  it('rejects malformed local project group create arguments before persistence', () => {
    expect(() =>
      handlers.get('projectGroups:create')!(null, { name: 123, createdFrom: 'unexpected' })
    ).toThrow('invalid_project_group_create_args')

    expect(mockStore.createProjectGroup).not.toHaveBeenCalled()
  })

  it('returns an immutable repo catalog for exactly one execution host', async () => {
    const localRepo = {
      id: 'duplicate',
      path: '/local/repo',
      displayName: 'local',
      badgeColor: '#000',
      addedAt: 0
    }
    const sshRepo = {
      id: 'duplicate',
      path: '/remote/repo',
      displayName: 'remote',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'conn-1'
    }
    const runtimeRepo = {
      id: 'duplicate',
      path: '/runtime/repo',
      displayName: 'runtime',
      badgeColor: '#000',
      addedAt: 0,
      executionHostId: 'runtime:environment-a'
    }
    mockStore.getRepos.mockReturnValue([localRepo, sshRepo, runtimeRepo])

    await expect(
      handlers.get('repos:listForExecutionHost')!(null, {
        executionHostId: toSshExecutionHostId('conn-1'),
        expectedAuthority: getSshProviderAuthority('conn-1')
      })
    ).resolves.toMatchObject({
      authoritative: true,
      authority: {
        kind: 'direct-ssh',
        executionHostId: 'ssh:conn-1',
        targetId: 'conn-1'
      },
      repos: [sshRepo]
    })

    const local = await handlers.get('repos:listForExecutionHost')!(null, {
      executionHostId: 'local'
    })
    expect(local).toMatchObject({ authoritative: true, repos: [localRepo] })
    expect((local as { repos: object[] }).repos[0]).not.toBe(localRepo)
  })

  it('rejects repo catalogs whose execution host contradicts their SSH connection', async () => {
    const baseRepo = {
      id: 'repo-1',
      path: '/repo',
      displayName: 'repo',
      badgeColor: '#000',
      addedAt: 0
    }
    mockStore.getRepos.mockReturnValue([
      {
        ...baseRepo,
        connectionId: 'conn-1',
        executionHostId: 'local'
      }
    ])

    await expect(
      handlers.get('repos:listForExecutionHost')!(null, {
        executionHostId: 'local'
      })
    ).resolves.toMatchObject({ authoritative: false, reason: 'rejected' })
    await expect(
      handlers.get('repos:listForExecutionHost')!(null, {
        executionHostId: toSshExecutionHostId('conn-1'),
        expectedAuthority: getSshProviderAuthority('conn-1')
      })
    ).resolves.toMatchObject({ authoritative: false, reason: 'rejected' })

    mockStore.getRepos.mockReturnValue([
      {
        ...baseRepo,
        connectionId: 'conn-1',
        executionHostId: toSshExecutionHostId('conn-2')
      }
    ])

    await expect(
      handlers.get('repos:listForExecutionHost')!(null, {
        executionHostId: toSshExecutionHostId('conn-1'),
        expectedAuthority: getSshProviderAuthority('conn-1')
      })
    ).resolves.toMatchObject({ authoritative: false, reason: 'rejected' })
  })

  it('rejects runtime, partial, mismatched, and stale catalog authority', async () => {
    await expect(
      handlers.get('repos:listForExecutionHost')!(null, {
        executionHostId: 'runtime:environment-a'
      })
    ).resolves.toMatchObject({ authoritative: false, reason: 'rejected' })
    await expect(
      handlers.get('repos:listForExecutionHost')!(null, {
        executionHostId: toSshExecutionHostId('conn-1')
      })
    ).resolves.toMatchObject({ authoritative: false, reason: 'rejected' })
    await expect(
      handlers.get('repos:listForExecutionHost')!(null, {
        executionHostId: toSshExecutionHostId('conn-1'),
        expectedAuthority: {
          ...getSshProviderAuthority('other-target'),
          targetId: 'other-target'
        }
      })
    ).resolves.toMatchObject({ authoritative: false, reason: 'rejected' })

    const expectedAuthority = getSshProviderAuthority('conn-1')
    const pending = handlers.get('repos:listForExecutionHost')!(null, {
      executionHostId: toSshExecutionHostId('conn-1'),
      expectedAuthority
    })
    rotateSshProviderAuthority('conn-1')
    await expect(pending).resolves.toMatchObject({ authoritative: false, reason: 'stale' })
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
})
