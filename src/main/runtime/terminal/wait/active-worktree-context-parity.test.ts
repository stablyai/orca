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
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { FolderWorkspace } from '../../../../shared/folder-workspaces/folder-workspace-types'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import type { Repo } from '../../../../shared/repo-types'
import type { WorktreeMeta } from '../../../../shared/worktree/meta-types'
import { getDefaultWorkspaceSession } from '../../../../shared/constants'
import { isWorkspaceKey, worktreeWorkspaceKey } from '../../../../shared/workspace-scope'
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

function sshRows(repoId: string, worktreeId: string, displayName: string): StoredRows {
  return {
    repos: [
      storeRepo({
        id: repoId,
        path: '/home/me/app',
        displayName: 'Box app',
        connectionId: 'devbox'
      })
    ],
    meta: { [worktreeId]: storeWorktreeMeta({ displayName }) },
    metaHostId: 'ssh:devbox'
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

/** What resolveActiveWorktreeContext answered before #38653: the legacy id through the unscoped selector. */
async function contextBefore(id: string, rows?: StoredRows): Promise<unknown> {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test reaches the protected selector main's resolveActiveWorktreeContext called; the shape is its declared return.
  const runtime = runtimeFor({ activeWorktreeId: id }, rows) as unknown as {
    resolveWorkspaceSelector: (selector: string) => Promise<{
      id: string
      git: { path: string; branch: string }
      displayName: string
    }>
  }
  const resolved = await runtime.resolveWorkspaceSelector(`id:${id}`)
  return {
    worktreeId: resolved.id,
    path: resolved.git.path,
    branch: resolved.git.branch,
    displayName: resolved.displayName
  }
}

function focused(id: string, hostId: ExecutionHostId | null): Session {
  return {
    activeWorktreeId: id,
    activeWorkspaceKey: `worktree:${id}`,
    activeWorkspaceExecutionHostId: hostId
  }
}

describe('active workspace context for a focused desktop-catalog workspace (real git checkout)', () => {
  const cases = (): { name: string; id: string }[] => [
    { name: 'main checkout', id: `${REPO_ID}::${repoPath}` },
    { name: 'linked worktree', id: `${REPO_ID}::${linkedPath}` },
    { name: 'folder workspace', id: 'folder:folder-1' }
  ]

  it('matches the pre-#38653 answer for every session shape the renderer writes', async () => {
    for (const { name, id } of cases()) {
      const before = await contextBefore(id)
      expect(before, name).toMatchObject({ worktreeId: id })
      // As set-active-worktree derives it.
      const key = isWorkspaceKey(id) ? id : worktreeWorkspaceKey(id)
      const shapes: Session[] = [
        { activeWorktreeId: id },
        { activeWorktreeId: id, activeWorkspaceKey: key, activeWorkspaceExecutionHostId: 'local' },
        { activeWorktreeId: id, activeWorkspaceKey: key, activeWorkspaceExecutionHostId: null },
        { activeWorktreeId: null, activeWorkspaceKey: key, activeWorkspaceExecutionHostId: 'local' }
      ]
      for (const session of shapes) {
        const runtime = runtimeFor(session)
        const workspaceContext = vi.fn(async () => null)
        runtime.setPairedWorkspaceContextSource({ workspaceContext })
        await expect(
          runtime.resolveActiveWorktreeContext(),
          `${name} ${JSON.stringify(session)}`
        ).resolves.toEqual(before)
        // A local focus never consults a paired server.
        expect(workspaceContext).not.toHaveBeenCalled()
      }
    }
  })

  it('matches the pre-#38653 answer for a focused SSH worktree whose host is not connected', async () => {
    const id = 'ssh-repo::/home/me/app-feature'
    for (const displayName of ['', 'Named on the box']) {
      const rows = sshRows('ssh-repo', id, displayName)
      await expect(
        runtimeFor(focused(id, 'ssh:devbox'), rows).resolveActiveWorktreeContext(),
        `meta name ${JSON.stringify(displayName)}`
      ).resolves.toEqual(await contextBefore(id, rows))
    }
  })

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
})
