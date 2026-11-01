import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserWindow } from 'electron'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { realpath } from 'node:fs/promises'
import type * as FsPromises from 'node:fs/promises'
import type * as ProjectRealpathIdentity from '../../project-realpath-identity'
import { closeTestStores, createStore, testState } from '../../persistence/persistence-test-harness'
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
import { registerRepoCreationHandlers } from './repo-creation-handlers'
import { prepareLocalWorktreeRootForRepo } from '../../worktree-root-preparation'
import { registerProjectHostSetupHandlers } from './project-host-setup-handlers'

import { registrationGitLayout } from './local-registration-git.test-fixture'
import { inspectGitRepoForRegistrationAsync } from '../../git/repo'
import { findProjectAtSameRealPath } from '../../project-realpath-identity'
import { detectRepoIconAndUpstream } from '../../repo-icon-autodetect'
import { notifyReposChanged } from './repos-changed-notification'
import { emitRepoAdded } from './repo-added-telemetry'
import { track } from '../../telemetry/client'

vi.mock(import('../../git/repo'), async (original) => {
  const actual = await original()
  return {
    ...actual,
    inspectGitRepoForRegistrationAsync: vi.fn(actual.inspectGitRepoForRegistrationAsync)
  }
})
vi.mock('../../project-realpath-identity', async (original) => {
  const actual = await original<typeof ProjectRealpathIdentity>()
  return { ...actual, findProjectAtSameRealPath: vi.fn(actual.findProjectAtSameRealPath) }
})
vi.mock(import('./repo-added-telemetry'), async (original) => {
  const actual = await original()
  return { ...actual, emitRepoAdded: vi.fn(actual.emitRepoAdded) }
})

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
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof FsPromises>()
  return { ...actual, realpath: vi.fn(actual.realpath) }
})
vi.mock('../../repo-icon-autodetect', () => ({
  detectRepoIconAndUpstream: vi.fn().mockResolvedValue({})
}))
vi.mock('../../worktree-root-preparation', () => ({
  prepareLocalWorktreeRootForRepo: vi.fn().mockResolvedValue(undefined)
}))
vi.mock('../../repo-git-remote-identity', () => ({
  readCurrentGitRemoteIdentity: vi.fn().mockResolvedValue({})
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
  vi.clearAllMocks()
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
      notifyReposChanged: vi.fn(),
      notifyWorktreesChanged: vi.fn()
    })

    await expect(controller.setBaseRef('repo-1', 'origin/dev')).resolves.toBe(onHost)
  })
})

it('keeps the repos:add creator record when a joining setup alignment is fenced by a WSL move', async () => {
  const path = join(testState.dir, 'chats')
  mkdirSync(path)
  const window = new BrowserWindow()
  registerRepoCreationHandlers(window, store)
  registerProjectHostSetupHandlers(window, store)
  const preparation = Promise.withResolvers<void>()
  vi.mocked(prepareLocalWorktreeRootForRepo).mockReturnValueOnce(preparation.promise)
  const creator = invoke('repos:add', { path, kind: 'folder' })
  await vi.waitFor(() => expect(store.getRepos()).toHaveLength(1))
  const added = store.getRepos()[0]
  const projectId = setupFor(added.id).projectId
  seedWslMoveCutover(
    testState.dir,
    cutover('move-join', 'source-fenced', {}, { repoIds: [added.id] })
  )
  const canonicalCalls = vi.mocked(realpath).mock.calls.length
  const joining = invoke('projectHostSetups:setupExistingFolder', {
    path,
    kind: 'folder',
    hostId: 'local',
    projectId
  })
  const fenced = expect(joining).rejects.toBeInstanceOf(WslMoveProjectFencedError)
  await vi.waitFor(() => expect(realpath).toHaveBeenCalledTimes(canonicalCalls + 1))
  await vi.mocked(realpath).mock.results[canonicalCalls].value
  preparation.resolve()
  await expect(creator).resolves.toMatchObject({ repo: { id: added.id } })
  await fenced
  expect(store.getRepo(added.id)).toMatchObject({ path, kind: 'folder' })
})

it.each([
  [true, 'lookup'],
  [true, 'discovery'],
  [true, 'preparation'],
  [false, 'lookup'],
  [false, 'discovery'],
  [false, 'preparation']
] as const)(
  'publishes its persisted folder when another resolved Git project is removed (linked=%s, phase=%s)',
  async (linked, phase) => {
    const root = await realpath(testState.dir)
    const { main, input } = await registrationGitLayout(root, linked)
    if (linked) {
      store.addRepo(repo('tracked-main', { path: main }))
    }
    const inspection = vi.mocked(inspectGitRepoForRegistrationAsync).getMockImplementation()!
    const facts = await inspection(input)
    const validation = Promise.withResolvers<typeof facts>()
    const gate = Promise.withResolvers<void>(),
      reached = Promise.withResolvers<void>(),
      creation = Promise.withResolvers<void>(),
      prepared = Promise.withResolvers<void>()
    vi.mocked(inspectGitRepoForRegistrationAsync).mockReturnValueOnce(validation.promise)
    registerRepoCreationHandlers(new BrowserWindow(), store)
    const git = invoke('repos:add', { path: input, kind: 'git' })
    let folder: Promise<unknown> | undefined
    try {
      await vi.waitFor(() => expect(inspectGitRepoForRegistrationAsync).toHaveBeenCalledOnce())
      if (phase === 'lookup') {
        const lookup = vi.mocked(findProjectAtSameRealPath).getMockImplementation()!
        vi.mocked(findProjectAtSameRealPath).mockImplementationOnce(async (...args) => {
          const row = await lookup(...args)
          reached.resolve()
          await gate.promise
          return row
        })
      } else {
        vi.mocked(detectRepoIconAndUpstream).mockImplementation(async ({ kind }) => {
          if (kind === 'folder') {
            reached.resolve()
            await (phase === 'preparation' ? creation.promise : gate.promise)
          }
          return {}
        })
        if (phase === 'preparation') {
          vi.mocked(prepareLocalWorktreeRootForRepo).mockImplementation(async (_store, row) => {
            if (row.kind === 'folder') {
              prepared.resolve()
              await gate.promise
            }
          })
        }
      }
      folder = invoke('repos:add', { path: input, kind: 'folder', displayName: 'My folder' })
      await reached.promise
      validation.resolve(facts)
      await expect(git).resolves.toMatchObject({ repo: { path: main, kind: 'git' } })
      if (phase === 'preparation') {
        creation.resolve()
        await prepared.promise
      }
      const parent = store.getRepos().find((row) => row.path === main)!
      store.removeProjectForHost(parent)
      gate.resolve()
      const current = await folder
      const own = store.getRepos().find((row) => row.path === input)!
      expect(current).toMatchObject({
        repo: { id: own.id, path: input, kind: 'folder', displayName: 'My folder' }
      })
      expect(store.getRepos()).toHaveLength(1)
      expect(emitRepoAdded).toHaveBeenLastCalledWith('folder_picker', false, false)
      expect(notifyReposChanged).toHaveBeenCalledTimes(2)
      expect(track).toHaveBeenLastCalledWith(
        'repo_added',
        expect.objectContaining({ method: 'folder_picker', is_git_repo: false })
      )
      expect(track).toHaveBeenCalledTimes(linked ? 1 : 2)
    } finally {
      validation.resolve(facts)
      gate.resolve()
      creation.resolve()
      await Promise.allSettled(folder ? [git, folder] : [git])
      vi.mocked(detectRepoIconAndUpstream).mockResolvedValue({})
      vi.mocked(prepareLocalWorktreeRootForRepo).mockResolvedValue(undefined)
    }
  }
)
