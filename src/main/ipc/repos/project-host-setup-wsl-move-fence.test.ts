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
import { RuntimeProjectHostSetupController } from '../../runtime/runtime-project-host-setup-controller'
import { RuntimeRepositoryIssueCommand } from '../../runtime/runtime-repository-issue-command'
import { RuntimeRepositorySettingsController } from '../../runtime/runtime-repository-settings-controller'
import * as issueCommandFile from '../../issue-command-file'
import { registerProjectHostSetupHandlers } from './project-host-setup-handlers'
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

function repo(id: string, extra: Partial<Repo> = {}): Repo {
  return {
    id,
    path: join(testState.dir, id),
    displayName: id,
    badgeColor: '#000',
    addedAt: 0,
    kind: 'git',
    ...extra
  }
}

let store: Store
beforeEach(() => {
  handlers.clear()
  testState.dir = mkdtempSync(join(tmpdir(), 'wsl-move-setup-ipc-'))
  store = createStore()
  loadWslMoveFence(testState.dir)
})
afterEach(async () => {
  resetWslMoveFenceForTests()
  await closeTestStores()
  rmSync(testState.dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

const setupFor = (repoId: string) => {
  const setup = store.getProjectHostSetups().find((entry) => entry.repoId === repoId)
  if (!setup) {
    throw new Error(`No setup for ${repoId}`)
  }
  return setup
}

describe('project host setups under a WSL move', () => {
  it('refuses IPC edits to a local setup of a moving repo and leaves others alone', async () => {
    store.addRepo(repo('repo-1'))
    store.addRepo(repo('repo-2'))
    seedWslMoveCutover(testState.dir, cutover('move-1', 'source-fenced'))
    registerProjectHostSetupHandlers(new BrowserWindow(), store)
    const moving = setupFor('repo-1')

    await expect(
      invoke('projectHostSetups:update', { setupId: moving.id, updates: { displayName: 'x' } })
    ).rejects.toBeInstanceOf(WslMoveProjectFencedError)
    await expect(invoke('projectHostSetups:delete', { setupId: moving.id })).rejects.toBeInstanceOf(
      WslMoveProjectFencedError
    )
    await expect(
      invoke('projectHostSetups:create', { projectId: moving.projectId, hostId: 'local' })
    ).rejects.toBeInstanceOf(WslMoveProjectFencedError)
    expect(setupFor('repo-1').displayName).toBe(moving.displayName)
    await expect(
      invoke('projectHostSetups:update', {
        setupId: setupFor('repo-2').id,
        updates: { displayName: 'renamed' }
      })
    ).resolves.toMatchObject({ setup: { displayName: 'renamed' } })
  })

  it("keeps a setup's own repo frozen once the WSL host owns it", async () => {
    store.addRepo(repo('repo-1'))
    seedWslMoveCutover(testState.dir, cutover('move-1', 'destination-committed'))
    registerProjectHostSetupHandlers(new BrowserWindow(), store)
    const owned = setupFor('repo-1')

    await expect(
      invoke('projectHostSetups:update', { setupId: owned.id, updates: { displayName: 'x' } })
    ).rejects.toBeInstanceOf(WslMoveProjectFencedError)
    await expect(invoke('projectHostSetups:delete', { setupId: owned.id })).rejects.toBeInstanceOf(
      WslMoveProjectFencedError
    )
  })

  it('refuses a runtime setup delete for a moving repo', () => {
    store.addRepo(repo('repo-1'))
    seedWslMoveCutover(testState.dir, cutover('move-1', 'source-fenced'))
    const controller = new RuntimeProjectHostSetupController({
      getStore: () => store,
      listRepos: () => store.getRepos(),
      addRepo: vi.fn(),
      cloneRepo: vi.fn(),
      invalidateResolvedWorktrees: vi.fn(),
      invalidateWorktreeScan: vi.fn(),
      notifyReposChanged: vi.fn(),
      countLiveTerminalsForRepo: () => 0
    })
    const setupId = setupFor('repo-1').id

    expect(() => controller.deleteSetup({ setupId })).toThrow(WslMoveProjectFencedError)
    expect(() => controller.updateSetup({ setupId, updates: { displayName: 'x' } })).toThrow(
      WslMoveProjectFencedError
    )
    expect(store.getRepo('repo-1')).toBeDefined()
  })
})

describe('projects:update once the WSL host owns a repo', () => {
  it('lets project-wide settings change again', async () => {
    store.addRepo(repo('repo-1'))
    seedWslMoveCutover(testState.dir, cutover('move-1', 'destination-committed'))
    registerRepoCatalogHandlers(new BrowserWindow(), store, { removeProject: vi.fn() })
    const project = store.getProjects().find((entry) => entry.sourceRepoIds.includes('repo-1'))
    const updates = { localWindowsRuntimePreference: { kind: 'windows-host' } }

    await expect(invoke('projects:update', { projectId: project?.id, updates })).resolves.toEqual(
      expect.objectContaining({ sourceRepoIds: ['repo-1'] })
    )
  })
})

describe('issue command writes under a WSL move', () => {
  it('refuses a runtime write to a moving repo before touching the file', async () => {
    store.addRepo(repo('repo-1'))
    seedWslMoveCutover(testState.dir, cutover('move-1', 'source-fenced'))
    const write = vi.spyOn(issueCommandFile, 'writeIssueCommand')
    const commands = new RuntimeRepositoryIssueCommand({
      resolveRepo: async (id) => repo(id),
      getLocalGitArgs: () => [],
      getStore: () => store
    })

    await expect(commands.write('repo-1', 'run')).rejects.toBeInstanceOf(WslMoveProjectFencedError)
    expect(write).not.toHaveBeenCalled()
  })
})

describe('repo settings on another host under a WSL move', () => {
  it('leaves a same-id repo row on another host writable', async () => {
    seedWslMoveCutover(testState.dir, cutover('move-1', 'source-fenced'))
    const onHost = repo('repo-1', { executionHostId: 'runtime:wsl:ubuntu' })
    vi.spyOn(store, 'updateRepo').mockReturnValue(onHost)
    const controller = new RuntimeRepositorySettingsController({
      getStore: () => store,
      resolveRepo: async () => onHost,
      forgetTerminalTopology: vi.fn(),
      invalidateResolvedWorktrees: vi.fn(),
      invalidateWorktreeScan: vi.fn(),
      notifyReposChanged: vi.fn()
    })

    await expect(controller.setBaseRef('repo-1', 'origin/dev')).resolves.toBe(onHost)
  })
})
