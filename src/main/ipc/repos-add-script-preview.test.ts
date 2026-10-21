import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as GitRunner from '../git/runner'
import type * as RepoModule from '../git/repo'
import type * as RunnerModule from '../repository-add-scripts/repository-add-script-runner'
import type { RepositoryAddScriptRunnerDependencies } from '../repository-add-scripts/repository-add-script-runner'
import type {
  RepositoryAddScriptAuthorizationCheck,
  RepositoryAddScriptRun
} from '../repository-add-scripts/repository-add-script-service'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { Repo } from '../../shared/repo-types'
import type { RepositoryAddScriptExecutionResult } from '../../shared/repository-add-script-types'

type FakeRun = (
  deps: RepositoryAddScriptRunnerDependencies,
  run: RepositoryAddScriptRun,
  isAuthorized: RepositoryAddScriptAuthorizationCheck,
  signal?: AbortSignal
) => Promise<RepositoryAddScriptExecutionResult>

const { reposMocks, moduleMocks, detectMock, runner } = await vi.hoisted(async () => {
  const moduleMocks = await import('./repos-remote-test-harness')
  const run = vi.fn<FakeRun>()
  return {
    reposMocks: moduleMocks.createReposIpcMocks(),
    moduleMocks,
    detectMock: vi.fn(),
    // Only this seam is replaced: nothing in this file may start a real process.
    runner: {
      run,
      factory: vi.fn(
        (deps: RepositoryAddScriptRunnerDependencies) =>
          (
            run_: RepositoryAddScriptRun,
            isAuthorized: RepositoryAddScriptAuthorizationCheck,
            signal?: AbortSignal
          ) =>
            run(deps, run_, isAuthorized, signal)
      )
    }
  }
})

vi.mock('electron', () => ({
  ...moduleMocks.electronModuleMock(reposMocks),
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  app: { getPath: vi.fn(() => '/tmp') }
}))
vi.mock('../git/repo', async (importOriginal) =>
  moduleMocks.gitRepoModuleMock(await importOriginal<typeof RepoModule>())
)
vi.mock('../git/runner', async (importOriginal) =>
  moduleMocks.gitRunnerModuleMock(reposMocks, await importOriginal<typeof GitRunner>())
)
vi.mock('../git/worktree', () => moduleMocks.gitWorktreeModuleMock(reposMocks))
vi.mock('./registered-worktree-roots-cache', () =>
  moduleMocks.registeredWorktreeRootsCacheModuleMock(reposMocks)
)
vi.mock('../worktree-root-preparation', () =>
  moduleMocks.worktreeRootPreparationModuleMock(reposMocks)
)
vi.mock('../repo-icon-autodetect', () => ({ detectRepoIconAndUpstream: detectMock }))
vi.mock('../repository-add-scripts/repository-add-script-runner', async (importOriginal) => ({
  ...(await importOriginal<typeof RunnerModule>()),
  createRepositoryAddScriptRunner: runner.factory
}))

import { registerRepoHandlers } from './repos'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { clearGitCapabilityStateForTests } from '../git/git-capability-state'
import { resetSshProviderAuthorities } from '../ssh/ssh-provider-authority'
import { isGitRepo } from '../git/repo'
import { createRepoHandlerHarness, resetLocalRepoMocks } from './repos-remote-test-harness'
import {
  isRecord,
  offerIdentityIn,
  offeredRepoIdsIn
} from '../repository-add-scripts/repository-add-script-wire-readers.test-fixture'

const { handleMock, mockStore } = reposMocks
const SCRIPT = 'echo prepared\n'
const ORIGINAL_PLATFORM = Object.getOwnPropertyDescriptor(process, 'platform')
const OPT_IN = { repositoryAddScriptPreview: { hostId: 'local' } }

function known(path: string): Repo {
  return {
    id: 'known',
    path,
    displayName: 'known',
    badgeColor: '#22c55e',
    addedAt: 1,
    kind: 'git'
  }
}

describe('IPC registration add-script offers', () => {
  const { handlers, mockWindow, captureHandlers } = createRepoHandlerHarness()
  const roots: string[] = []
  let repos: Repo[]
  let collectorSpy: MockInstance<OrcaRuntimeService['createRepositoryAddScriptCollector']>

  const makeRoot = async (): Promise<string> => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'orca-add-script-preview-')))
    roots.push(root)
    return root
  }
  // Async so a handler that throws before its first await still rejects the returned promise.
  const invoke = async (channel: string, args: unknown): Promise<unknown> =>
    await handlers.get(channel)!(null, args)
  const invokeRecord = async (channel: string, args: unknown): Promise<Record<string, unknown>> => {
    const result = await invoke(channel, args)
    if (!isRecord(result)) {
      throw new Error(`Expected ${channel} to resolve an object.`)
    }
    return result
  }

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { ...ORIGINAL_PLATFORM, value: 'linux' })
    clearGitCapabilityStateForTests()
    resetSshProviderAuthorities()
    captureHandlers(handleMock)
    resetLocalRepoMocks(reposMocks)
    detectMock.mockReset().mockResolvedValue({})
    repos = []
    mockStore.getRepos.mockImplementation(() => repos)
    mockStore.addRepo.mockImplementation((repo: Repo) => repos.push(repo))
    mockStore.removeProjectForHost.mockImplementation((repo: Repo) => {
      repos = repos.filter((candidate) => candidate.id !== repo.id)
    })
    const settings: Partial<GlobalSettings> = { machineName: 'Studio', repositoryAddScript: SCRIPT }
    const runtime = new OrcaRuntimeService(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the add-script authority reads only the catalog and settings members below.
      {
        getRepos: () => repos,
        getRepo: (id: string) => repos.find((repo) => repo.id === id),
        getProjects: () => [],
        getSettings: () => settings
      } as never
    )
    collectorSpy = vi.spyOn(runtime, 'createRepositoryAddScriptCollector')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handlers only touch the window, store and runtime members these fakes define.
    registerRepoHandlers(mockWindow as never, mockStore as never, runtime as never)
  })

  afterEach(async () => {
    if (ORIGINAL_PLATFORM) {
      Object.defineProperty(process, 'platform', ORIGINAL_PLATFORM)
    }
    runner.run.mockReset()
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  describe('repos:add and repos:create', () => {
    it('returns the legacy shape and builds no collector without the opt-in', async () => {
      const result = await invokeRecord('repos:add', { path: '/tmp/new-git', kind: 'git' })

      expect(Object.keys(result)).toEqual(['repo'])
      expect(collectorSpy).not.toHaveBeenCalled()
    })

    it('offers a new Git row to the request that opted in, keeping the requested alias', async () => {
      const local = await invokeRecord('repos:add', { path: '/tmp/new-git', ...OPT_IN })
      const aliased = await invokeRecord('repos:add', {
        path: '/tmp/other-git',
        repositoryAddScriptPreview: { hostId: 'runtime:env-1' }
      })

      expect(local).toMatchObject({
        repositoryAddScriptPreview: { hostId: 'local', script: SCRIPT }
      })
      expect(aliased).toMatchObject({ repositoryAddScriptPreview: { hostId: 'runtime:env-1' } })
      expect(collectorSpy).toHaveBeenCalledTimes(2)
    })

    it('offers nothing for a known repo, a folder, or a linked worktree of a known repo', async () => {
      repos.push(known('/tmp/known'))

      const reopened = await invokeRecord('repos:add', { path: '/tmp/known', ...OPT_IN })
      const folder = await invokeRecord('repos:add', {
        path: '/tmp/notes',
        kind: 'folder',
        ...OPT_IN
      })

      expect(Object.keys(reopened)).toEqual(['repo'])
      expect(Object.keys(folder)).toEqual(['repo'])
    })

    it.each([
      ['an SSH alias', { hostId: 'ssh:box' }],
      ['a spelling the runtime would rewrite', { hostId: ' local' }],
      ['a stray field', { hostId: 'local', script: 'x' }],
      ['a flag that is not an object', true]
    ])('rejects %s before registering or building a collector', async (_label, flag) => {
      const result = await invokeRecord('repos:add', {
        path: '/tmp/new-git',
        repositoryAddScriptPreview: flag
      })

      expect(result).toEqual({ error: expect.stringContaining('add script') })
      expect(repos).toHaveLength(0)
      expect(collectorSpy).not.toHaveBeenCalled()
    })

    it('offers a created Git repo once and none for a repeat create', async () => {
      const root = await makeRoot()
      const args = { parentPath: root, name: 'made', kind: 'git', ...OPT_IN }

      const first = await invokeRecord('repos:create', args)
      const repeat = await invokeRecord('repos:create', args)

      expect(first).toMatchObject({ repositoryAddScriptPreview: { repoId: repos[0].id } })
      expect(Object.keys(repeat)).toEqual(['repo'])
      expect(repos).toHaveLength(1)
    })

    it('rejects an invalid create opt-in without creating the folder', async () => {
      const root = await makeRoot()

      const result = await invokeRecord('repos:create', {
        parentPath: root,
        name: 'made',
        kind: 'git',
        repositoryAddScriptPreview: { hostId: 'ssh:box' }
      })

      expect(result).toHaveProperty('error')
      expect(repos).toHaveLength(0)
    })
  })

  describe('repos:clone', () => {
    it('keeps returning a bare Repo without the opt-in', async () => {
      const destination = await makeRoot()

      const result = await invokeRecord('repos:clone', {
        url: 'https://example.com/orca.git',
        destination
      })

      expect(result).toMatchObject({ id: repos[0].id, kind: 'git' })
      expect(result).not.toHaveProperty('repo')
      expect(collectorSpy).not.toHaveBeenCalled()
    })

    it('wraps the row with its offer when the caller opted in', async () => {
      const destination = await makeRoot()

      const result = await invokeRecord('repos:clone', {
        url: 'https://example.com/orca.git',
        destination,
        ...OPT_IN
      })

      expect(result).toMatchObject({
        repo: { id: repos[0].id },
        repositoryAddScriptPreview: { repoId: repos[0].id }
      })
    })

    it('wraps a reused saved project with no offer', async () => {
      const destination = await makeRoot()
      repos.push({
        ...known(join(destination, 'orca')),
        gitRemoteIdentity: {
          canonicalKey: 'example.com/orca',
          remoteName: 'origin',
          remoteUrl: 'https://example.com/orca.git'
        }
      })
      reposMocks.gitExecFileAsyncMock.mockRejectedValue(new Error('spawn ENOENT'))

      const result = await invokeRecord('repos:clone', {
        url: 'https://example.com/orca.git',
        destination,
        ...OPT_IN
      })

      expect(Object.keys(result)).toEqual(['repo'])
    })

    it('rejects an invalid opt-in before cloning anything', async () => {
      await expect(
        invoke('repos:clone', {
          url: 'https://example.com/orca.git',
          destination: await makeRoot(),
          repositoryAddScriptPreview: { hostId: 'ssh:box' }
        })
      ).rejects.toThrow('invalid_repository_add_script_request')
      expect(reposMocks.gitSpawnMock).not.toHaveBeenCalled()
    })
  })

  describe('projectGroups:importNested', () => {
    async function withTree(run: (root: string) => Promise<void>): Promise<void> {
      const root = await makeRoot()
      for (const dir of ['api', 'web', 'docs']) {
        await mkdir(join(root, dir, '.git'), { recursive: true })
      }
      vi.mocked(isGitRepo).mockImplementation((path: string) => path !== root)
      mockStore.createProjectGroup.mockReturnValue({ id: 'group-1', name: 'Group' })
      await run(root)
    }
    const importArgs = (root: string, dirs: string[]) => ({
      parentPath: root,
      groupName: 'Group',
      projectPaths: dirs.map((dir) => join(root, dir)),
      mode: 'group',
      ...OPT_IN
    })

    it('offers each repo this import inserted and not the one already known', async () => {
      await withTree(async (root) => {
        repos.push(known(join(root, 'api')))

        const result = await invokeRecord(
          'projectGroups:importNested',
          importArgs(root, ['api', 'web', 'docs'])
        )

        expect(result).toMatchObject({ importedCount: 2, alreadyKnownCount: 1 })
        expect(offeredRepoIdsIn(result)).toEqual(repos.slice(1).map((repo) => repo.id))
        expect(JSON.stringify(result.projects)).not.toContain('repositoryAddScript')
      })
    })

    it('adds no preview key when nothing was inserted or no opt-in was sent', async () => {
      await withTree(async (root) => {
        const plain = await invokeRecord('projectGroups:importNested', {
          ...importArgs(root, ['api']),
          repositoryAddScriptPreview: undefined
        })
        repos.push(known(join(root, 'web')))
        const none = await invokeRecord('projectGroups:importNested', importArgs(root, ['web']))

        expect(plain).not.toHaveProperty('repositoryAddScriptPreviews')
        expect(none).not.toHaveProperty('repositoryAddScriptPreviews')
      })
    })
  })

  describe('projectHostSetups:setupExistingFolder', () => {
    const setupArgs = {
      projectId: 'project-1',
      hostId: 'local',
      path: '/tmp/setup-new',
      kind: 'git'
    }

    function linkProject(): void {
      mockStore.getProjects.mockReturnValue([{ id: 'project-1', displayName: 'Project' }])
      mockStore.getProjectHostSetups.mockImplementation(() =>
        repos.map((repo) => ({
          id: repo.id,
          projectId: 'project-1',
          repoId: repo.id,
          hostId: 'local',
          path: repo.path,
          displayName: repo.displayName,
          setupState: 'ready',
          setupMethod: 'imported-existing-folder'
        }))
      )
      mockStore.updateRepo.mockImplementation((target: { id: string }, updates: object) => {
        const index = repos.findIndex((repo) => repo.id === target.id)
        repos[index] = { ...repos[index], ...updates }
        return repos[index]
      })
    }

    it('offers the new repo once the project link succeeded', async () => {
      linkProject()

      const result = await invokeRecord('projectHostSetups:setupExistingFolder', {
        ...setupArgs,
        ...OPT_IN
      })

      expect(result).toMatchObject({
        repo: { id: repos[0].id },
        repositoryAddScriptPreview: { repoId: repos[0].id, hostId: 'local' }
      })
    })

    it('offers nothing for a known repo', async () => {
      repos.push(known('/tmp/setup-new'))
      linkProject()

      const result = await invokeRecord('projectHostSetups:setupExistingFolder', {
        ...setupArgs,
        ...OPT_IN
      })

      expect(result).not.toHaveProperty('repositoryAddScriptPreview')
    })

    it('offers nothing when the link fails and the registration is rolled back', async () => {
      await expect(
        invoke('projectHostSetups:setupExistingFolder', {
          ...setupArgs,
          projectId: 'github:acme/orca',
          projectProviderIdentity: { provider: 'github', owner: 'other', repo: 'orca' },
          ...OPT_IN
        })
      ).rejects.toThrow('Imported folder does not match the selected project identity.')

      expect(repos).toHaveLength(0)
      const collector = collectorSpy.mock.results[0]?.value
      expect(collector?.previews()).toEqual([])
    })

    it('rejects an invalid opt-in before touching the filesystem catalog', async () => {
      await expect(
        invoke('projectHostSetups:setupExistingFolder', {
          ...setupArgs,
          repositoryAddScriptPreview: { hostId: 'ssh:box' }
        })
      ).rejects.toThrow('project_host_setup_invalid_args')
      expect(repos).toHaveLength(0)
    })
  })

  describe('decide and outcome channels', () => {
    async function offered() {
      const result = await invokeRecord('repos:add', { path: '/tmp/new-git', ...OPT_IN })
      return offerIdentityIn(result)
    }

    it('runs an approved token exactly once and reads its outcome by full identity', async () => {
      runner.run.mockResolvedValue({ exitCode: 0, output: 'done' })
      const identity = await offered()

      const first = await invokeRecord('repos:decideAddScript', { ...identity, decision: 'run' })
      const second = await invokeRecord('repos:decideAddScript', { ...identity, decision: 'run' })

      expect(first).toMatchObject({ status: 'succeeded' })
      expect(second).toMatchObject({ status: 'rejected', reason: 'used-token' })
      expect(runner.run).toHaveBeenCalledTimes(1)
      await expect(invoke('repos:getAddScriptOutcome', identity)).resolves.toMatchObject({
        status: 'succeeded'
      })
      await expect(
        invoke('repos:getAddScriptOutcome', { ...identity, repoId: 'other' })
      ).resolves.toBeNull()
    })

    it('does not run when the offer was skipped', async () => {
      const identity = await offered()

      await expect(
        invoke('repos:decideAddScript', { ...identity, decision: 'skip' })
      ).resolves.toMatchObject({ status: 'skipped' })
      expect(runner.run).not.toHaveBeenCalled()
    })

    it.each([
      ['a script', { script: 'echo hi' }],
      ['a path', { path: '/tmp/new-git' }],
      ['a target', { target: { kind: 'native', cwd: '/tmp' } }],
      ['an SSH host', { hostId: 'ssh:box' }]
    ])('refuses a decision that carries %s', async (_label, extra) => {
      const identity = await offered()

      await expect(
        invoke('repos:decideAddScript', { ...identity, decision: 'run', ...extra })
      ).rejects.toThrow('repository_add_script_decide_invalid_args')
      expect(runner.run).not.toHaveBeenCalled()
    })

    it('refuses an outcome read that carries a decision', async () => {
      const identity = await offered()

      await expect(
        invoke('repos:getAddScriptOutcome', { ...identity, decision: 'run' })
      ).rejects.toThrow('repository_add_script_outcome_invalid_args')
    })

    it('registers no offer, list or revoke channel', () => {
      const channels = [...handlers.keys()].filter((channel) => /AddScript/i.test(channel))
      expect(channels.sort()).toEqual(['repos:decideAddScript', 'repos:getAddScriptOutcome'])
    })
  })
})
