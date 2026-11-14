import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RuntimeProjectGroupController } from './runtime-project-group-controller'
import type { RuntimeStore } from '../construction/runtime-store-contract'
import { FolderWorkspacePersistenceOperations } from '../../persistence/restoring-sessions/folder-workspace-operations'
import { getDefaultPersistedState } from '../../../shared/constants'
import type { FolderWorkspace } from '../../../shared/folder-workspaces/folder-workspace-types'
import type { ProjectGroup } from '../../../shared/project-group-types'

const unused = (): never => {
  throw new Error('unused')
}

function folderRow(overrides: Partial<FolderWorkspace>): FolderWorkspace {
  return {
    id: 'hub-a',
    projectGroupId: 'group-1',
    name: 'Hub',
    folderPath: '/work/hub',
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

/** The real persisted folder rows behind a runtime store, with PTY teardown the test can hook into. */
function createController(
  rows: FolderWorkspace[],
  onTeardown: () => void = () => undefined,
  groups: ProjectGroup[] = []
) {
  const state = { ...getDefaultPersistedState('/home/me'), folderWorkspaces: rows }
  const folders = new FolderWorkspacePersistenceOperations({
    state,
    scheduleSave: () => undefined,
    removeWorkspaceLineageForRemovedFolder: () => undefined,
    pruneMobileClientTabSelections: () => undefined,
    hydrateRepo: (repo) => repo
  })
  const store: RuntimeStore = {
    getProjectGroups: () => groups,
    getRepos: () => [],
    getFolderWorkspaces: () => folders.getFolderWorkspaces(),
    getFolderWorkspace: (id: string) => folders.getFolderWorkspace(id),
    updateFolderWorkspace: (id, updates) => folders.updateFolderWorkspace(id, updates),
    removeFolderWorkspace: (id) => folders.removeFolderWorkspace(id),
    getRepo: unused,
    addRepo: unused,
    updateRepo: unused,
    getAllWorktreeMeta: unused,
    getWorktreeMeta: unused,
    setWorktreeMeta: unused,
    removeWorktreeMeta: unused,
    getGitHubCache: unused,
    getSettings: unused
  }
  const controller = new RuntimeProjectGroupController({
    getStore: () => store,
    resolveRepo: unused,
    notifyReposChanged: () => undefined,
    resolveFolderConnectionId: () => null,
    teardownFolderWorkspacePtys: async () => onTeardown(),
    acquireFileWatcherRemoval: async () => ({ finish: async () => undefined }),
    cleanupRemovedFolderWorkspaceState: () => undefined,
    emitWorktreeLifecycle: () => undefined
  })
  return { controller, state }
}

describe('folder workspace deletion with requireUniqueId', () => {
  it('refuses the delete when a twin appears during teardown', async () => {
    const twin = folderRow({ comment: 'added during teardown' })
    const deps = createController([folderRow({ comment: 'selected' })], () => {
      deps.state.folderWorkspaces = [...deps.state.folderWorkspaces, twin]
    })

    await expect(
      deps.controller.deleteFolderWorkspace('hub-a', { requireUniqueId: true })
    ).rejects.toMatchObject({ code: 'selector_ambiguous' })

    expect(deps.state.folderWorkspaces.map((row) => row.comment)).toEqual([
      'selected',
      'added during teardown'
    ])
  })
})

function archiveGroup(root: string, exitCode: number): ProjectGroup {
  return {
    id: 'group-1',
    name: 'Group',
    parentPath: root,
    parentGroupId: null,
    createdFrom: 'manual',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1,
    hookSettings: {
      mode: 'override',
      commandSourcePolicy: 'local-only',
      scripts: {
        setup: '',
        archive: `node -e "require('fs').writeFileSync(process.env.ORCA_ROOT_PATH + '/archive.txt', JSON.stringify({id:process.env.ORCA_WORKSPACE_ID,name:process.env.ORCA_WORKSPACE_NAME,path:process.env.ORCA_WORKTREE_PATH}));process.exit(${exitCode})"`
      }
    }
  }
}

it('refuses group-folder removal when Archive fails, then honors an explicit waiver', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-group-archive-'))
  const group = archiveGroup(root, 7)
  const deps = createController([folderRow({ folderPath: root })], undefined, [group])
  try {
    await expect(
      deps.controller.deleteFolderWorkspace('hub-a', { runHooks: true })
    ).rejects.toMatchObject({ code: 'worktree_archive_hook_failed' })
    expect(deps.state.folderWorkspaces.map((row) => row.id)).toEqual(['hub-a'])

    await deps.controller.deleteFolderWorkspace('hub-a', {
      runHooks: true,
      allowFailedArchiveHook: true
    })
    expect(deps.state.folderWorkspaces).toEqual([])
    expect(await readFile(join(root, 'archive.txt'), 'utf8')).toContain('"id":"folder:hub-a"')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('runs Archive with the saved folder identity and preserves the group directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-group-archive-'))
  const group = archiveGroup(root, 0)
  const workspacePath = join(root, 'saved workspace')
  const deps = createController(
    [folderRow({ folderPath: workspacePath, name: 'Saved workspace' })],
    () => {
      expect(deps.state.folderWorkspaces).toHaveLength(1)
    },
    [group]
  )
  try {
    await deps.controller.deleteFolderWorkspace('hub-a', { runHooks: true })
    expect(JSON.parse(await readFile(join(root, 'archive.txt'), 'utf8'))).toEqual({
      id: 'folder:hub-a',
      name: 'Saved workspace',
      path: workspacePath
    })
    expect(deps.state.folderWorkspaces).toEqual([])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
