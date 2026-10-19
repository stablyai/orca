import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserWindow } from 'electron'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { closeTestStores, createStore, testState } from '../../persistence-test-harness'
import type { Store } from '../../persistence'
import type { Repo } from '../../../shared/repo-types'
import { wslMoveCutoverFixture as cutover } from '../../persistence/__fixtures__/wsl-mover/wsl-move-cutover-fixture'
import { seedWslMoveCutover } from '../../persistence/__fixtures__/wsl-mover/wsl-move-journal-seeding'
import {
  WslMoveProjectFencedError,
  loadWslMoveFence,
  resetWslMoveFenceForTests
} from '../../persistence/moving-wsl-projects/wsl-move-scope-guard'
import { RuntimeRepositorySettingsController } from '../../runtime/runtime-repository-settings-controller'
import { registerFolderWorkspaceHandlers } from './folder-workspace-handlers'
import { registerRepoCatalogHandlers } from './repo-catalog-handlers'

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, args: unknown) => unknown>()
}))
vi.mock('electron', () => ({
  BrowserWindow: class {},
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false },
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, args: unknown) => unknown) => {
      handlers.set(channel, handler)
    }
  }
}))
vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn() }))
vi.mock('./repos-changed-notification', () => ({ notifyReposChanged: vi.fn() }))

async function invoke(channel: string, args: unknown): Promise<unknown> {
  const handler = handlers.get(channel)
  if (!handler) {
    throw new Error(`Handler not registered: ${channel}`)
  }
  return handler(undefined, args)
}

function repo(id: string): Repo {
  return {
    id,
    path: join(testState.dir, id),
    displayName: id,
    badgeColor: '#000',
    addedAt: 0,
    kind: 'git'
  }
}

let store: Store
beforeEach(() => {
  handlers.clear()
  testState.dir = mkdtempSync(join(tmpdir(), 'wsl-move-repo-ipc-'))
  store = createStore()
  loadWslMoveFence(testState.dir)
})
afterEach(async () => {
  resetWslMoveFenceForTests()
  await closeTestStores()
  rmSync(testState.dir, { recursive: true, force: true })
})

describe('folderWorkspaces:update under a WSL move', () => {
  it('drops a passive update quietly and refuses a user edit', async () => {
    const group = store.createProjectGroup({
      name: 'Docs',
      parentPath: testState.dir,
      createdFrom: 'folder-scan'
    })
    const workspace = store.createFolderWorkspace({ projectGroupId: group.id, name: 'notes' })
    seedWslMoveCutover(
      testState.dir,
      cutover('move-1', 'source-fenced', {}, { folderWorkspaceIds: [workspace.id] })
    )
    registerFolderWorkspaceHandlers(new BrowserWindow(), store, {
      deleteFolderWorkspace: vi.fn(async () => ({ deleted: true }))
    })

    await expect(
      invoke('folderWorkspaces:update', {
        folderWorkspaceId: workspace.id,
        updates: { isUnread: true, lastActivityAt: 1 }
      })
    ).resolves.toMatchObject({ id: workspace.id, isUnread: workspace.isUnread })
    await expect(
      invoke('folderWorkspaces:update', {
        folderWorkspaceId: workspace.id,
        updates: { isUnread: true }
      })
    ).rejects.toBeInstanceOf(WslMoveProjectFencedError)
    await expect(
      invoke('folderWorkspaces:update', {
        folderWorkspaceId: workspace.id,
        updates: { name: 'renamed' }
      })
    ).rejects.toBeInstanceOf(WslMoveProjectFencedError)
    expect(store.getFolderWorkspace(workspace.id)).toMatchObject({
      name: 'notes',
      isUnread: workspace.isUnread
    })
  })
})

describe('projects:update under a WSL move', () => {
  it('refuses a runtime preference change when a source repo is moving', async () => {
    store.addRepo(repo('repo-1'))
    store.addRepo(repo('repo-2'))
    seedWslMoveCutover(testState.dir, cutover('move-1', 'source-fenced'))
    registerRepoCatalogHandlers(new BrowserWindow(), store, { removeProject: vi.fn() })
    const projectFor = (repoId: string) =>
      store.getProjects().find((project) => project.sourceRepoIds.includes(repoId))
    const updates = { localWindowsRuntimePreference: { kind: 'windows-host' } }

    await expect(
      invoke('projects:update', { projectId: projectFor('repo-1')?.id, updates })
    ).rejects.toBeInstanceOf(WslMoveProjectFencedError)
    await expect(
      invoke('projects:update', { projectId: projectFor('repo-2')?.id, updates })
    ).resolves.toMatchObject({ sourceRepoIds: ['repo-2'] })
  })
})

describe('RuntimeRepositorySettingsController under a WSL move', () => {
  it('refuses a settings edit to a moving repo and writes nothing', async () => {
    store.addRepo(repo('repo-1'))
    seedWslMoveCutover(testState.dir, cutover('move-1', 'source-fenced'))
    const notifyReposChanged = vi.fn()
    const controller = new RuntimeRepositorySettingsController({
      getStore: () => store,
      resolveRepo: async (id) => repo(id),
      forgetTerminalTopology: vi.fn(),
      invalidateResolvedWorktrees: vi.fn(),
      invalidateWorktreeScan: vi.fn(),
      notifyReposChanged
    })

    await expect(controller.update('repo-1', { displayName: 'renamed' })).rejects.toBeInstanceOf(
      WslMoveProjectFencedError
    )
    await expect(controller.setBaseRef('repo-1', 'origin/dev')).rejects.toBeInstanceOf(
      WslMoveProjectFencedError
    )
    expect(store.getRepo('repo-1')?.displayName).toBe('repo-1')
    expect(notifyReposChanged).not.toHaveBeenCalled()
  })
})
