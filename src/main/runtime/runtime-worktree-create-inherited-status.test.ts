import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp'), isPackaged: false }
}))

const createRuntimeLocalManagedWorktreeMock = vi.hoisted(() => vi.fn())
vi.mock('./runtime-local-worktree-create', () => ({
  createRuntimeLocalManagedWorktree: createRuntimeLocalManagedWorktreeMock
}))

import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import type { WorkspaceStatus } from '../../shared/worktree/types'
import { mergeWorktree } from '../ipc/worktree-metadata-merge'
import type { RuntimeManagedWorktreeCreateArgs } from './runtime-managed-worktree-create-types'
import { OrcaRuntimeService } from './orca-runtime'
import {
  withParentWorkspaceStatus,
  type ParentWorkspaceStatusStore
} from './runtime-worktree-create-inherited-status'
import type { WorktreeLineageResolution } from './runtime-worktree-lineage-resolution'
import type { ResolvedWorktree } from './runtime-worktree-path-identity'

const request: RuntimeManagedWorktreeCreateArgs = { repoSelector: 'id:repo-1', name: 'child' }
const PARENT_ID = 'repo-1::/workspaces/parent'

function makeMeta(overrides: Partial<WorktreeMeta> = {}): WorktreeMeta {
  return {
    displayName: 'parent',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...overrides
  }
}

function makeStore(
  meta: Record<string, WorktreeMeta> = {},
  metaForHost: Record<string, WorktreeMeta> = {}
): ParentWorkspaceStatusStore {
  return {
    getRepo: () => undefined,
    getWorktreeMeta: (worktreeId) => meta[worktreeId],
    getWorktreeMetaForHost: (worktreeId, hostId) => metaForHost[`${hostId}|${worktreeId}`]
  }
}

// The snapshot status is what the short-lived resolved-worktree cache returned for the parent.
function worktreeParent(snapshotStatus?: WorkspaceStatus): WorktreeLineageResolution {
  const git = {
    path: '/workspaces/parent',
    head: 'abc123',
    branch: 'refs/heads/parent',
    isBare: false,
    isMainWorktree: false
  }
  const worktree: ResolvedWorktree = {
    ...mergeWorktree(
      'repo-1',
      git,
      makeMeta(snapshotStatus ? { workspaceStatus: snapshotStatus } : {})
    ),
    parentWorktreeId: null,
    childWorktreeIds: [],
    lineage: null,
    git
  }
  return {
    kind: 'lineage',
    parent: {
      type: 'worktree',
      workspaceKey: `worktree:${worktree.id}`,
      worktree,
      instanceId: null
    },
    origin: 'cli',
    capture: { source: 'cwd-context', confidence: 'inferred' }
  }
}

function folderParent(workspaceStatus?: WorkspaceStatus): WorktreeLineageResolution {
  const folderWorkspace: FolderWorkspace = {
    id: 'folder-1',
    projectGroupId: 'group-1',
    name: 'Docs',
    folderPath: '/folders/docs',
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1,
    createdAt: 1,
    updatedAt: 1,
    ...(workspaceStatus ? { workspaceStatus } : {})
  }
  return {
    kind: 'lineage',
    parent: { type: 'folder', workspaceKey: 'folder:folder-1', folderWorkspace, instanceId: null },
    origin: 'cli',
    capture: { source: 'explicit-cli-flag', confidence: 'explicit' }
  }
}

describe('withParentWorkspaceStatus', () => {
  it('reads the parent worktree status from persisted metadata, not the resolved snapshot', () => {
    const store = makeStore({ [PARENT_ID]: makeMeta({ workspaceStatus: 'completed' }) })
    expect(
      withParentWorkspaceStatus(request, worktreeParent('in-progress'), store).workspaceStatus
    ).toBe('completed')
  })

  it('prefers the parent row owned by its execution host', () => {
    const store = makeStore(
      { [PARENT_ID]: makeMeta({ workspaceStatus: 'todo' }) },
      { [`local|${PARENT_ID}`]: makeMeta({ workspaceStatus: 'in-review' }) }
    )
    expect(
      withParentWorkspaceStatus(request, worktreeParent('in-progress'), store).workspaceStatus
    ).toBe('in-review')
  })

  it('ignores a same-id row owned by another host', () => {
    const store = makeStore({
      [PARENT_ID]: makeMeta({ hostId: 'ssh:other', workspaceStatus: 'todo' })
    })
    expect(
      withParentWorkspaceStatus(request, worktreeParent('in-review'), store).workspaceStatus
    ).toBe('in-review')
  })

  it('starts a child worktree in its parent folder status', () => {
    expect(
      withParentWorkspaceStatus(request, folderParent('in-review'), makeStore()).workspaceStatus
    ).toBe('in-review')
  })

  it('keeps an explicitly requested status', () => {
    const explicit = { ...request, workspaceStatus: 'todo' }
    const store = makeStore({ [PARENT_ID]: makeMeta({ workspaceStatus: 'completed' }) })
    expect(
      withParentWorkspaceStatus(explicit, worktreeParent('completed'), store).workspaceStatus
    ).toBe('todo')
  })

  it('leaves the status unset without a parent', () => {
    expect(
      withParentWorkspaceStatus(request, { kind: 'none', warnings: [] }, makeStore())
        .workspaceStatus
    ).toBeUndefined()
  })

  it('leaves the status unset when the parent folder has none', () => {
    expect(
      withParentWorkspaceStatus(request, folderParent(), makeStore()).workspaceStatus
    ).toBeUndefined()
  })
})

describe('createManagedWorktree parent workspace status', () => {
  type RuntimeInternals = {
    resolveRepoSelector: (selector: string) => Promise<unknown>
    resolveLineageForWorktreeCreate: (input: unknown) => Promise<unknown>
    createManagedRemoteWorktree: (repo: unknown, args: unknown) => Promise<unknown>
    recordCreatedWorktreeLineage: (worktree: unknown, resolution: unknown) => unknown
  }

  function makeRuntime(repo: Record<string, unknown>) {
    const store = {
      ...makeStore({ [PARENT_ID]: makeMeta({ workspaceStatus: 'completed' }) }),
      getSettings: () => ({ disabledTuiAgents: [], workspaceDir: '/tmp/workspaces' }),
      getProjectHostSetups: () => []
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the create path only reads these store methods before the stubbed create.
    const runtime = new OrcaRuntimeService(store as never)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: exposes protected members for stubbing, matching the other create-path tests.
    const internals = runtime as unknown as RuntimeInternals
    vi.spyOn(internals, 'resolveRepoSelector').mockResolvedValue(repo)
    // The resolved parent is a stale snapshot; the store already holds the parent's new status.
    vi.spyOn(internals, 'resolveLineageForWorktreeCreate').mockResolvedValue(
      worktreeParent('in-progress')
    )
    vi.spyOn(internals, 'recordCreatedWorktreeLineage').mockReturnValue({
      lineage: null,
      workspaceLineage: null,
      warnings: []
    })
    const createRemote = vi.fn().mockResolvedValue({
      worktree: { id: 'wt-1', path: '/srv/app-child', branch: 'child' }
    })
    vi.spyOn(internals, 'createManagedRemoteWorktree').mockImplementation(createRemote)
    return { runtime, createRemote }
  }

  it('passes the parent status to a local create', async () => {
    createRuntimeLocalManagedWorktreeMock.mockReset()
    createRuntimeLocalManagedWorktreeMock.mockRejectedValue(new Error('stop_after_request'))
    const { runtime } = makeRuntime({ id: 'repo-1', path: '/repos/app', kind: 'git' })

    await expect(runtime.createManagedWorktree(request)).rejects.toThrow('stop_after_request')

    expect(createRuntimeLocalManagedWorktreeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({ workspaceStatus: 'completed' })
      })
    )
  })

  it('passes the parent status to an SSH create', async () => {
    const { runtime, createRemote } = makeRuntime({
      id: 'repo-1',
      path: '/srv/app',
      kind: 'git',
      executionHostId: 'ssh:remote-1'
    })

    await runtime.createManagedWorktree(request)

    expect(createRemote).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ workspaceStatus: 'completed' })
    )
  })
})
