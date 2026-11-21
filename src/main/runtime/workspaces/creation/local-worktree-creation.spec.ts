import * as gitExecFile from '../../../git/command-runner/git-exec-file'
import { describe, expect, it, vi } from 'vitest'
import '../../construction/test-context/runtime-test-module-registration.spec'
import { OrcaRuntimeService } from '../../orca-runtime'
import { addWorktree } from '../../../git/worktrees/creation/worktree-add'
import {
  addWorktreeMock,
  computeWorktreePathMock,
  deleteWorktreeHistoryDirMock,
  ensurePathWithinWorkspaceMock
} from '../../orca-runtime-test-mocks/setup.spec'
import '../../../git/refs/resolution/repo-default-base-ref'
import '../../../git/refs/resolution/repo-branch-conflict'
import { listWorktrees } from '../../../git/worktrees/catalog/worktree-scan-cache'
import type { WorktreeMeta } from '../../../../shared/worktree/meta-types'
import {
  TEST_REPO_PATH,
  makeWorktreeMeta,
  store
} from '../../construction/test-context/orca-runtime-test-fixtures.spec'
import type { HostWorktreeTarget } from '../../../../shared/worktree/host-qualified-identity'

describe('OrcaRuntimeService', () => {
  it('reports stale local base drift without replacing the selected base', async () => {
    const runtime = new OrcaRuntimeService(store)
    const createdWorktree = {
      path: '/tmp/workspaces/local-stale-base',
      head: 'develop-sha',
      branch: 'local-stale-base',
      isBare: false,
      isMainWorktree: false
    }
    const repo = { ...store.getRepos()[0]!, worktreeBaseRef: 'develop' }
    const getReposSpy = vi.spyOn(store, 'getRepos').mockReturnValue([repo])
    computeWorktreePathMock.mockReturnValue(createdWorktree.path)
    ensurePathWithinWorkspaceMock.mockReturnValue(createdWorktree.path)
    vi.mocked(addWorktree).mockResolvedValueOnce({})
    vi.mocked(listWorktrees).mockResolvedValueOnce([createdWorktree])
    const gitSpy = vi.spyOn(gitExecFile, 'gitExecFileAsync').mockImplementation(async (args) => {
      if (args[0] === 'remote') {
        return { stdout: 'origin\n', stderr: '' }
      }
      if (args[0] === 'rev-list') {
        return { stdout: '0\t692\n', stderr: '' }
      }
      if (args[0] === 'rev-parse' && args.includes('refs/heads/develop^{commit}')) {
        return { stdout: 'develop-sha\n', stderr: '' }
      }
      if (args.includes('fetch')) {
        throw new Error('network unavailable')
      }
      return { stdout: '', stderr: '' }
    })
    try {
      const result = await runtime.createManagedWorktree({
        repoSelector: 'id:repo-1',
        name: 'local-stale-base'
      })
      expect(addWorktree).toHaveBeenCalledWith(
        TEST_REPO_PATH,
        createdWorktree.path,
        'local-stale-base',
        'develop',
        false,
        false,
        {}
      )
      expect(result.localBaseRefDriftWarning).toEqual({
        baseRef: 'develop',
        defaultBaseRef: 'origin/main',
        ahead: 0,
        behind: 692,
        relation: 'behind'
      })
      expect(result.warning).toContain('develop is 692 commit(s) behind origin/main')
    } finally {
      getReposSpy.mockRestore()
      gitSpy.mockRestore()
    }
  })

  it('creates additional workspace metadata for folder-mode repos through runtime create', async () => {
    const folderRepo = {
      id: 'folder-repo',
      path: '/workspace/folder',
      displayName: 'Folder',
      badgeColor: 'blue',
      addedAt: 1,
      kind: 'folder' as const,
      // This selected runtime owns removal; its PTY ids are local.
      executionHostId: 'runtime:env-1' as const
    }
    const rootWorktreeId = 'folder-repo::/workspace/folder'
    const rootPriorWorktreeIds = ['folder-repo::/workspace/old-folder']
    const metaById: Record<string, WorktreeMeta> = {
      [rootWorktreeId]: makeWorktreeMeta({
        instanceId: 'root-instance',
        priorWorktreeIds: rootPriorWorktreeIds
      })
    }
    const runtimeStore = {
      ...store,
      getRepos: () => [folderRepo],
      getRepo: (id: string) => (id === folderRepo.id ? folderRepo : undefined),
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: ({ id: worktreeId }: HostWorktreeTarget, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...(metaById[worktreeId] ?? makeWorktreeMeta()), ...meta }
        return metaById[worktreeId]
      },
      removeWorktreeMeta: ({ id: worktreeId }: HostWorktreeTarget) => {
        delete metaById[worktreeId]
      }
    }
    let deletedWorktreeId = ''
    const localProvider = {
      listProcesses: vi.fn(async () => [{ id: `${deletedWorktreeId}@@pty-1` }]),
      shutdown: vi.fn(async () => undefined)
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never, undefined, {
      getLocalProvider: () => localProvider as never
    })
    runtime.setPtyController({
      spawn: vi.fn(),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const createTerminal = vi.spyOn(runtime, 'createTerminal').mockResolvedValue({
      handle: 'term_folder_startup',
      tabId: 'tab-folder-startup',
      worktreeId: '',
      title: null,
      surface: 'background'
    })
    const notifier = { worktreesChanged: vi.fn() }
    runtime.setNotifier(notifier as never)

    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:folder-repo',
      name: 'folder-session',
      lineage: { cwdParentWorktree: 'id:stale', cwdParentAmbiguous: true },
      displayName: '\u0000\u202e',
      displayNameKind: 'user',
      createdWithAgent: 'codex',
      startup: { command: 'codex', viewMode: 'chat' }
    })

    expect(result.lineage).toBeUndefined()
    expect(result.worktree.lineage).toBeNull()
    expect(addWorktreeMock).not.toHaveBeenCalled()
    expect(createTerminal).toHaveBeenCalledWith(
      `id:${result.worktree.id}`,
      expect.objectContaining({ command: 'codex', viewMode: 'chat' })
    )
    expect(result.worktree).toEqual(
      expect.objectContaining({
        id: expect.stringMatching(/^folder-repo::\/workspace\/folder::workspace:[0-9a-f-]{36}$/),
        repoId: 'folder-repo',
        path: '/workspace/folder',
        displayName: 'folder-session',
        isMainWorktree: false,
        createdWithAgent: 'codex'
      })
    )
    expect(metaById[result.worktree.id]).toMatchObject({
      instanceId: result.worktree.instanceId,
      displayName: 'folder-session',
      orcaCreationSource: 'runtime',
      createdWithAgent: 'codex'
    })
    expect(metaById[result.worktree.id]).not.toHaveProperty('displayNameIsPinned')
    await expect(runtime.showManagedWorktree(`id:${result.worktree.id}`)).resolves.toMatchObject({
      id: result.worktree.id,
      repoId: 'folder-repo',
      path: '/workspace/folder',
      displayName: 'folder-session'
    })
    await expect(runtime.listManagedWorktrees('id:folder-repo')).resolves.toMatchObject({
      totalCount: 2,
      worktrees: [
        expect.objectContaining({
          id: rootWorktreeId,
          isMainWorktree: true,
          priorWorktreeIds: rootPriorWorktreeIds
        }),
        expect.objectContaining({
          id: result.worktree.id,
          isMainWorktree: false
        })
      ]
    })
    await expect(
      runtime.updateManagedWorktreeMeta(`id:${result.worktree.id}`, { comment: 'note' })
    ).resolves.toMatchObject({
      id: result.worktree.id,
      comment: 'note'
    })
    await expect(
      runtime.removeManagedWorktree('id:folder-repo::/workspace/folder')
    ).rejects.toThrow('Cannot delete the project root workspace')
    deletedWorktreeId = result.worktree.id
    await expect(runtime.removeManagedWorktree(`id:${result.worktree.id}`)).resolves.toEqual({})
    expect(localProvider.shutdown).toHaveBeenCalledWith(
      `${result.worktree.id}@@pty-1`,
      expect.objectContaining({ immediate: true })
    )
    expect(metaById[result.worktree.id]).toBeUndefined()
    expect(deleteWorktreeHistoryDirMock).toHaveBeenCalledWith(result.worktree.id)
    expect(notifier.worktreesChanged).toHaveBeenCalledWith('folder-repo')
  })
})
