import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

const { handleMock, mockStore, listWorktreeGraphMock } = reposMocks

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

  // Why: a local tree whose root is a plain folder and whose listed dirs are git repos.
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

  it('uses completed scan ids as an allowlist for nested imports', async () => {
    mockStore.createProjectGroup.mockReturnValue(group)
    await withNestedTree(['api', join('node_modules', 'hidden')], async (root) => {
      await handlers.get('projectGroups:scanNested')!(
        { sender: { send: vi.fn() } },
        { path: root, scanId: 'scan-import-allowlist' }
      )

      const result = await handlers.get('projectGroups:importNested')!(null, {
        parentPath: root,
        groupName: 'Platform',
        projectPaths: [join(root, 'api'), join(root, 'node_modules', 'hidden')],
        scanId: 'scan-import-allowlist',
        mode: 'group'
      })

      expect(result).toMatchObject({ importedCount: 1, failedCount: 1 })
      expect(mockStore.addRepo).toHaveBeenCalledTimes(1)
      expect(mockStore.addRepo).toHaveBeenCalledWith(
        expect.objectContaining({ path: join(root, 'api') })
      )
    })
  })

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

      expect(result).toMatchObject({ importedCount: 0, failedCount: 1 })
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

  it('imports a small selection from a large nested scan', async () => {
    mockStore.createProjectGroup.mockReturnValue(group)
    const names = Array.from(
      { length: 87 },
      (_, index) => `service-${String(index + 1).padStart(2, '0')}`
    )
    await withNestedTree(names, async (root) => {
      const selectedPaths = [names[2], names[41], names[86]].map((name) => join(root, name))

      const result = await handlers.get('projectGroups:importNested')!(null, {
        parentPath: root,
        groupName: 'Platform',
        projectPaths: selectedPaths,
        mode: 'group'
      })

      expect(result).toMatchObject({ importedCount: 3, alreadyKnownCount: 0, failedCount: 0 })
      expect(mockStore.addRepo).toHaveBeenCalledTimes(3)
      for (const path of selectedPaths) {
        expect(mockStore.addRepo).toHaveBeenCalledWith(
          expect.objectContaining({ path, projectGroupId: group.id })
        )
      }
    })
  })

  it('imports selected local linked worktrees as one project rooted at the main worktree', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'orca-nested-linked-worktrees-'))
    try {
      const parentPath = join(tempRoot, 'paseo-worktrees', 'demo-project')
      const mainPath = join(tempRoot, 'source', 'demo-project')
      const firstWorktreePath = join(parentPath, 'brash-binder')
      const secondWorktreePath = join(parentPath, 'quick-howler')
      await mkdir(join(firstWorktreePath, '.git'), { recursive: true })
      await mkdir(join(secondWorktreePath, '.git'), { recursive: true })
      await mkdir(mainPath, { recursive: true })
      vi.mocked(isGitRepo).mockReturnValue(false)
      vi.mocked(isGitRepo).mockImplementation((path: string) =>
        [firstWorktreePath, secondWorktreePath, mainPath].includes(path)
      )
      listWorktreeGraphMock.mockResolvedValue([
        {
          path: mainPath,
          head: 'main-head',
          branch: 'refs/heads/main',
          isBare: false,
          isMainWorktree: true
        },
        {
          path: firstWorktreePath,
          head: 'feature-head',
          branch: 'refs/heads/brash-binder',
          isBare: false,
          isMainWorktree: false
        },
        {
          path: secondWorktreePath,
          head: 'feature-head',
          branch: 'refs/heads/quick-howler',
          isBare: false,
          isMainWorktree: false
        }
      ])

      const result = await handlers.get('projectGroups:importNested')!(null, {
        parentPath,
        groupName: '',
        projectPaths: [firstWorktreePath, secondWorktreePath],
        mode: 'separate'
      })

      expect(result).toMatchObject({
        importedCount: 1,
        alreadyKnownCount: 1,
        failedCount: 0
      })
      expect(mockStore.addRepo).toHaveBeenCalledTimes(1)
      expect(mockStore.addRepo).toHaveBeenCalledWith(expect.objectContaining({ path: mainPath }))
      expect(listWorktreeGraphMock).toHaveBeenCalledTimes(1)
      expect((result as { projects: { projectId?: string }[] }).projects[0].projectId).toBe(
        (result as { projects: { projectId?: string }[] }).projects[1].projectId
      )
    } finally {
      await rm(tempRoot, { recursive: true, force: true })
    }
  })

  it('sanitizes unexpected nested import errors before returning results', async () => {
    mockStore.createProjectGroup.mockReturnValue(group)
    await withNestedTree(['api'], async (root) => {
      mockStore.addRepo.mockImplementationOnce(() => {
        throw new Error(`secret backend path ${join(root, 'api')}`)
      })

      const result = await handlers.get('projectGroups:importNested')!(null, {
        parentPath: root,
        groupName: 'Platform',
        projectPaths: [join(root, 'api')],
        mode: 'group'
      })

      expect(result).toMatchObject({ projects: [{ error: 'Repository could not be imported' }] })
    })
  })
})
