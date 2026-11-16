// #38653: the remote fallback must leave a focused local or SSH workspace's context exactly as the catalog answered it.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => {
  const ipcMain = {
    on: vi.fn(() => ipcMain),
    removeListener: vi.fn(() => ipcMain),
    emit: vi.fn(() => true)
  }
  return {
    BrowserWindow: { fromId: vi.fn((): unknown => null) },
    webContents: { fromId: vi.fn((): unknown => null) },
    ipcMain,
    app: { getPath: vi.fn(() => tmpdir()), isPackaged: false }
  }
})

import { OrcaRuntimeService } from '../../orca-runtime'
import type { ExecutionHostId } from '../../../../shared/execution-host/execution-host'
import type { FolderWorkspace } from '../../../../shared/folder-workspaces/folder-workspace-types'
import type { ProjectGroup } from '../../../../shared/project/groups/project-group-types'
import type { Repo } from '../../../../shared/repository/repo-types'
import type { WorktreeMeta } from '../../../../shared/worktree/meta-types'
import { getDefaultWorkspaceSession } from '../../../../shared/orca-profiles/constants'

import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'
import {
  partialRuntimeStore,
  storeRepo,
  storeWorktreeMeta
} from '../../orca-runtime-tests/runtime-store-partial-fixture'

type Session = Partial<
  Pick<
    WorkspaceSessionState,
    'activeWorktreeId' | 'activeWorkspaceKey' | 'activeWorkspaceExecutionHostId'
  >
>

const REPO_ID = 'local-repo'
let root = ''
let repoPath = ''
let linkedPath = ''
let folderPath = ''

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'orca-38653-')))
  repoPath = join(root, 'repo')
  linkedPath = join(root, 'linked')
  folderPath = join(root, 'folder')
  execFileSync('mkdir', ['-p', repoPath, folderPath])
  git(repoPath, 'init', '-q', '-b', 'main')
  git(
    repoPath,
    '-c',
    'user.email=t@t',
    '-c',
    'user.name=t',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'init'
  )
  git(repoPath, 'worktree', 'add', '-q', '-b', 'feature/parity', linkedPath)
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

type StoredRows = {
  repos: Repo[]
  meta: Record<string, WorktreeMeta>
  /** The host whose host-qualified meta read answers. */
  metaHostId: ExecutionHostId
}

function localRows(): StoredRows {
  return {
    repos: [storeRepo({ id: REPO_ID, path: repoPath, displayName: 'Local repo' })],
    meta: { [`${REPO_ID}::${linkedPath}`]: storeWorktreeMeta({ displayName: 'Parity feature' }) },
    metaHostId: 'local'
  }
}

function runtimeFor(session: Session, rows: StoredRows = localRows()): OrcaRuntimeService {
  const { repos, meta, metaHostId } = rows
  const group: ProjectGroup = {
    id: 'group-1',
    name: 'Group',
    parentPath: root,
    parentGroupId: null,
    createdFrom: 'folder-scan',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1
  }
  const folder: FolderWorkspace = {
    id: 'folder-1',
    projectGroupId: group.id,
    name: 'Local folder',
    folderPath,
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1,
    createdAt: 1,
    updatedAt: 1
  }
  const store = partialRuntimeStore({
    getRepo: (id: string) => repos.find((repo) => repo.id === id),
    getRepos: () => repos,
    getAllWorktreeMeta: () => meta,
    getWorktreeMeta: (id: string) => meta[id],
    setWorktreeMeta: ({ id }: { id: string }, patch: Partial<WorktreeMeta>) => {
      meta[id] = { ...storeWorktreeMeta(), ...meta[id], ...patch }
      return meta[id]
    },
    getWorktreeMetaForHost: (id: string, hostId: ExecutionHostId) =>
      hostId === metaHostId ? meta[id] : undefined,
    getAllWorktreeLineage: () => ({}),
    getAllWorkspaceLineage: () => ({}),
    getProjects: () => [],
    getProjectGroups: () => [group],
    getFolderWorkspaces: () => [folder],
    getFolderWorkspace: (id: string) => (id === folder.id ? folder : undefined),
    getWorkspaceSession: () => ({ ...getDefaultWorkspaceSession(), ...session })
  })
  return new OrcaRuntimeService(store)
}

function focused(id: string, hostId: ExecutionHostId | null): Session {
  return {
    activeWorktreeId: id,
    activeWorkspaceKey: `worktree:${id}`,
    activeWorkspaceExecutionHostId: hostId
  }
}

describe('active workspace context for a focused desktop-catalog workspace (real git checkout)', () => {
  it("never answers the local twin's context for a paired-server focus with the same id", async () => {
    const id = `${REPO_ID}::${linkedPath}`
    const session = focused(id, 'runtime:env-1')
    // Server unreachable: no context, rather than the desktop's own checkout.
    await expect(runtimeFor(session).resolveActiveWorktreeContext()).resolves.toBeNull()
    const runtime = runtimeFor(session)
    runtime.setPairedWorkspaceContextSource({
      workspaceContext: async (hostId, worktreeId) => ({
        worktreeId,
        path: `/srv/${hostId}`,
        branch: 'refs/heads/server',
        displayName: 'Server copy'
      })
    })
    await expect(runtime.resolveActiveWorktreeContext()).resolves.toMatchObject({
      path: '/srv/runtime:env-1'
    })
  })

  it('answers null on the start screen even while another workspace has an open terminal', async () => {
    const id = `${REPO_ID}::${linkedPath}`
    const runtime = runtimeFor({ activeWorktreeId: null, activeWorkspaceKey: null })
    await runtime.syncWindowGraph(1, {
      tabs: [
        { tabId: 'tab-b', worktreeId: id, title: 'zsh', activeLeafId: 'pane:1', layout: null }
      ],
      leaves: []
    })
    await expect(runtime.resolveActiveWorktreeContext()).resolves.toBeNull()
  })
})
