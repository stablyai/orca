import '../../git/command-runner/git-exec-file'
import { describe, expect, it, vi } from 'vitest'
import './runtime-test-module-registration.spec'
import { OrcaRuntimeService } from '../orca-runtime'
import { addWorktree } from '../../git/worktrees/creation/worktree-add'
import {
  computeWorktreePathMock,
  ensurePathWithinWorkspaceMock
} from '../orca-runtime-test-mocks/setup.spec'
import '../../git/refs/resolution/repo-branch-conflict'
import { listWorktrees } from '../../git/worktrees/catalog/worktree-scan-cache'
import { SshHostNotServedError } from '../../providers/ssh-host-not-served-error'
import type { WorkspaceLineage } from '../../../shared/worktree/lineage-types'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import {
  TEST_FOLDER_WORKSPACE_KEY,
  TEST_REPO_ID,
  createFolderWorkspaceRuntimeStore,
  makeWorktreeMeta,
  store
} from './orca-runtime-test-fixtures.spec'
import type { HostWorktreeTarget } from '../../../shared/worktree/host-qualified-identity'

describe('OrcaRuntimeService', () => {
  it('refuses an SSH-backed create for mobile/runtime callers instead of creating locally', async () => {
    vi.mocked(listWorktrees).mockClear()
    vi.mocked(addWorktree).mockClear()
    const remoteStore = {
      ...store,
      getRepos: () => [
        {
          id: TEST_REPO_ID,
          path: '/remote/repo',
          displayName: 'repo',
          badgeColor: 'blue',
          addedAt: 1,
          connectionId: 'ssh-1'
        }
      ]
    }
    const runtime = new OrcaRuntimeService(remoteStore as never)

    await expect(
      runtime.createManagedWorktree({ repoSelector: TEST_REPO_ID, name: 'mobile-feature' })
    ).rejects.toThrow(SshHostNotServedError)

    expect(addWorktree).not.toHaveBeenCalled()
    expect(listWorktrees).not.toHaveBeenCalled()
  })

  // The same parent selection must keep manual cleanup semantics across hosts.
  it('records an app-selected parent workspace as a manual action', async () => {
    vi.mocked(addWorktree).mockClear()
    const created = {
      path: '/tmp/workspaces/manual-child',
      head: 'def',
      branch: 'refs/heads/manual-child',
      isBare: false,
      isMainWorktree: false
    }
    const childId = `${TEST_REPO_ID}::${created.path}`
    const metaById: Record<string, WorktreeMeta> = {}
    const runtimeStore = {
      ...createFolderWorkspaceRuntimeStore(),
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: ({ id: worktreeId }: HostWorktreeTarget, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...(metaById[worktreeId] ?? makeWorktreeMeta()), ...meta }
        return metaById[worktreeId]
      },
      setFolderParentLineage: vi.fn(
        (_target: HostWorktreeTarget, lineage: WorkspaceLineage) => lineage
      )
    }
    computeWorktreePathMock.mockReturnValue(created.path)
    ensurePathWithinWorkspaceMock.mockImplementation((pathValue: string) => pathValue)
    vi.mocked(listWorktrees).mockResolvedValueOnce([created])
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    const result = await runtime.createManagedWorktree({
      repoSelector: TEST_REPO_ID,
      name: 'manual-child',
      baseBranch: 'origin/main',
      lineage: {
        parentWorkspace: TEST_FOLDER_WORKSPACE_KEY,
        parentWorkspaceOrigin: 'manual'
      }
    })

    expect(result.workspaceLineage).toMatchObject({
      childWorkspaceKey: `worktree:${childId}`,
      parentWorkspaceKey: TEST_FOLDER_WORKSPACE_KEY,
      origin: 'manual',
      capture: { source: 'active-workspace', confidence: 'explicit' }
    })
  })
})
