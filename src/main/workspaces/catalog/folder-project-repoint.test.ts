import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Repo } from '../../../shared/repo-types'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import {
  FOLDER_WORKSPACE_INSTANCE_SEPARATOR,
  getRepoMainWorktreeId
} from '../../../shared/worktree/id'
import { hostWorktreeTarget } from '../../../shared/worktree/host-qualified-identity'
import {
  closeTestStores,
  createStore,
  makeRepo,
  testState
} from '../../persistence/persistence-test-harness'
import { makeTerminalTab } from '../../persistence/persistence-session-fixtures'
import { wslMoveCutoverFixture as cutover } from '../../persistence/__fixtures__/wsl-mover/wsl-move-cutover-fixture'
import { seedWslMoveCutover } from '../../persistence/__fixtures__/wsl-mover/wsl-move-journal-seeding'
import {
  WslMoveProjectFencedError,
  loadWslMoveFence,
  resetWslMoveFenceForTests
} from '../../persistence/moving-wsl-projects/quiescence/wsl-move-scope-guard'
import type { Store } from '../../persistence/loading-store/store'
import { repointMovedFolderProject } from './folder-project-repoint'

const EXTRA_INSTANCE_SUFFIX = `${FOLDER_WORKSPACE_INSTANCE_SEPARATOR}55555555-5555-4555-8555-555555555555`

describe('repointMovedFolderProject', () => {
  let root: string
  let oldFolder: string
  let newFolder: string
  let store: Store
  let repo: Repo

  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-folder-repoint-'))
    root = testState.dir
    oldFolder = join(root, 'proj-old')
    newFolder = join(root, 'proj-new')
    mkdirSync(oldFolder)
    store = createStore()
    repo = makeRepo({ id: 'repo-1', path: oldFolder, kind: 'folder' })
    store.addRepo(repo)
  })

  afterEach(async () => {
    resetWslMoveFenceForTests()
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  const mainWorktreeId = (): string => getRepoMainWorktreeId(repo)

  function seedWorkspaceState(): void {
    store.setWorktreeMeta(hostWorktreeTarget({ id: mainWorktreeId(), hostId: 'local' }), {
      displayName: 'Main checkout'
    })
    store.setWorktreeMeta(
      hostWorktreeTarget({ id: `${mainWorktreeId()}${EXTRA_INSTANCE_SUFFIX}`, hostId: 'local' }),
      { displayName: 'Extra workspace' }
    )
    store.setWorkspaceSession({
      ...getDefaultWorkspaceSession(),
      activeRepoId: repo.id,
      activeWorktreeId: mainWorktreeId(),
      activeTabId: 'tab1',
      tabsByWorktree: {
        [mainWorktreeId()]: [makeTerminalTab({ id: 'tab1', worktreeId: mainWorktreeId() })]
      },
      terminalLayoutsByTabId: {}
    })
  }

  it('repoints a moved folder project in place and re-keys its workspaces', async () => {
    seedWorkspaceState()
    rmSync(oldFolder, { recursive: true, force: true })
    mkdirSync(newFolder)
    const oldMainId = mainWorktreeId()

    const result = await repointMovedFolderProject(store, {
      projectId: `repo:${repo.id}`,
      folderPath: newFolder,
      kind: 'folder'
    })

    expect(result).toMatchObject({ outcome: 'repointed' })
    const repos = store.getRepos()
    expect(repos).toHaveLength(1)
    expect(repos[0]).toMatchObject({ id: repo.id, path: newFolder, kind: 'folder' })
    expect(store.getWorktreeMeta(oldMainId)).toBeUndefined()
    const newMainId = getRepoMainWorktreeId({ ...repo, path: newFolder })
    expect(store.getWorktreeMeta(newMainId)?.displayName).toBe('Main checkout')
    expect(store.getWorktreeMeta(newMainId)?.priorWorktreeIds).toEqual([oldMainId])
    expect(store.getWorktreeMeta(`${newMainId}${EXTRA_INSTANCE_SUFFIX}`)?.displayName).toBe(
      'Extra workspace'
    )
    const session = store.getWorkspaceSession()
    expect(session.tabsByWorktree[oldMainId]).toBeUndefined()
    expect(session.tabsByWorktree[newMainId]?.[0]?.worktreeId).toBe(newMainId)
    expect(store.getProjectHostSetups().find((setup) => setup.repoId === repo.id)?.path).toBe(
      newFolder
    )
  })

  it('keeps the normal import flow while the recorded folder still exists', async () => {
    seedWorkspaceState()
    mkdirSync(newFolder)

    const result = await repointMovedFolderProject(store, {
      projectId: `repo:${repo.id}`,
      folderPath: newFolder,
      kind: 'folder'
    })

    expect(result).toEqual({ outcome: 'not-applicable' })
    expect(store.getRepos()[0]?.path).toBe(oldFolder)
    expect(store.getWorktreeMeta(mainWorktreeId())?.displayName).toBe('Main checkout')
  })

  it('refuses a repoint onto a location that is not a usable folder', async () => {
    rmSync(oldFolder, { recursive: true, force: true })

    const result = await repointMovedFolderProject(store, {
      projectId: `repo:${repo.id}`,
      folderPath: newFolder,
      kind: 'folder'
    })

    expect(result).toEqual({
      outcome: 'refused',
      reason: `Orca cannot find ${newFolder}. Choose the folder's new location.`
    })
    expect(store.getRepos()[0]?.path).toBe(oldFolder)
  })

  it('refuses a repoint onto a folder another project already registered', async () => {
    rmSync(oldFolder, { recursive: true, force: true })
    mkdirSync(newFolder)
    store.addRepo(makeRepo({ id: 'repo-2', path: newFolder, kind: 'folder' }))

    const result = await repointMovedFolderProject(store, {
      projectId: `repo:${repo.id}`,
      folderPath: newFolder,
      kind: 'folder'
    })

    expect(result).toEqual({
      outcome: 'refused',
      reason: `Another project already uses this folder: ${newFolder}`
    })
    expect(store.getRepos()).toHaveLength(2)
  })

  it('leaves git projects to the re-import flow', async () => {
    store.updateRepo(repo, { kind: 'git' })
    rmSync(oldFolder, { recursive: true, force: true })
    mkdirSync(newFolder)

    const result = await repointMovedFolderProject(store, {
      projectId: `repo:${repo.id}`,
      folderPath: newFolder,
      kind: 'folder'
    })

    expect(result).toEqual({ outcome: 'not-applicable' })
    expect(store.getRepos()[0]?.path).toBe(oldFolder)
  })

  it('leaves an import without an explicit folder kind to the import flow', async () => {
    rmSync(oldFolder, { recursive: true, force: true })
    mkdirSync(newFolder)

    const result = await repointMovedFolderProject(store, {
      projectId: `repo:${repo.id}`,
      folderPath: newFolder
    })

    expect(result).toEqual({ outcome: 'not-applicable' })
    expect(store.getRepos()[0]?.path).toBe(oldFolder)
  })

  it('refuses to migrate when a WSL move fences the project after the entry check', async () => {
    seedWorkspaceState()
    rmSync(oldFolder, { recursive: true, force: true })
    mkdirSync(newFolder)
    seedWslMoveCutover(testState.dir, cutover('move-1', 'source-fenced'))
    loadWslMoveFence(testState.dir)
    const oldMainId = mainWorktreeId()

    // Called directly, so no handler entry check stands between the fence and the migration.
    await expect(
      repointMovedFolderProject(store, {
        projectId: `repo:${repo.id}`,
        folderPath: newFolder,
        kind: 'folder'
      })
    ).rejects.toBeInstanceOf(WslMoveProjectFencedError)
    expect(store.getRepos()[0]?.path).toBe(oldFolder)
    expect(store.getWorktreeMeta(oldMainId)?.displayName).toBe('Main checkout')
  })

  it.skipIf(process.platform === 'win32')(
    'keeps the selected folder spelling instead of trimming it',
    async () => {
      rmSync(oldFolder, { recursive: true, force: true })
      mkdirSync(newFolder)
      // A sibling whose name is the selected path minus its trailing space must not win.
      const selected = `${newFolder} `
      mkdirSync(selected)

      const result = await repointMovedFolderProject(store, {
        projectId: `repo:${repo.id}`,
        folderPath: selected,
        kind: 'folder'
      })

      expect(result).toMatchObject({ outcome: 'repointed' })
      expect(store.getRepos()[0]?.path).toBe(selected)
    }
  )

  it.skipIf(process.platform === 'win32')(
    'refuses a repoint onto a symlink alias of another project',
    async () => {
      rmSync(oldFolder, { recursive: true, force: true })
      const registered = join(root, 'registered')
      mkdirSync(registered)
      store.addRepo(makeRepo({ id: 'repo-2', path: registered, kind: 'folder' }))
      const alias = join(root, 'alias')
      symlinkSync(registered, alias, 'dir')

      const result = await repointMovedFolderProject(store, {
        projectId: `repo:${repo.id}`,
        folderPath: alias,
        kind: 'folder'
      })

      expect(result).toMatchObject({ outcome: 'refused' })
      expect(store.getRepo(repo.id)?.path).toBe(oldFolder)
    }
  )
})
