import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { ProjectExecutionRuntimeResolution } from '../../shared/project-execution-runtime'
import type { Project } from '../../shared/project-types'
import type { Repo } from '../../shared/repo-types'
import type {
  RepositoryAddScriptExecutionResult,
  RepositoryAddScriptPreview
} from '../../shared/repository-add-script-types'
import type * as RunnerModule from '../repository-add-scripts/repository-add-script-runner'
import type { RepositoryAddScriptRunnerDependencies } from '../repository-add-scripts/repository-add-script-runner'
import type {
  RepositoryAddScriptAuthorizationCheck,
  RepositoryAddScriptRun
} from '../repository-add-scripts/repository-add-script-service'

type FakeRun = (
  deps: RepositoryAddScriptRunnerDependencies,
  run: RepositoryAddScriptRun,
  isAuthorized: RepositoryAddScriptAuthorizationCheck,
  signal?: AbortSignal
) => Promise<RepositoryAddScriptExecutionResult>

// Only this seam is replaced: nothing in this file may start a real process.
const runner = vi.hoisted(() => {
  const run = vi.fn<FakeRun>()
  const factory = vi.fn(
    (deps: RepositoryAddScriptRunnerDependencies) =>
      (
        run_: RepositoryAddScriptRun,
        isAuthorized: RepositoryAddScriptAuthorizationCheck,
        signal?: AbortSignal
      ) =>
        run(deps, run_, isAuthorized, signal)
  )
  return { run, factory }
})
vi.mock('../repository-add-scripts/repository-add-script-runner', async (importOriginal) => ({
  ...(await importOriginal<typeof RunnerModule>()),
  createRepositoryAddScriptRunner: runner.factory
}))
vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

import { OrcaRuntimeService } from './orca-runtime'

const SCRIPT = 'echo prepared\n'
const ORIGINAL_PLATFORM = Object.getOwnPropertyDescriptor(process, 'platform')

function gitRepo(id: string, path = `/work/${id}`, extra: Partial<Repo> = {}): Repo {
  return {
    id,
    path,
    displayName: id,
    badgeColor: '',
    addedAt: 1,
    kind: 'git',
    executionHostId: 'local',
    ...extra
  }
}

function setup(
  options: { repos?: Repo[]; projects?: Project[]; settings?: Partial<GlobalSettings> } = {}
) {
  const repos = [...(options.repos ?? [])]
  const projects = [...(options.projects ?? [])]
  let settings: Partial<GlobalSettings> = {
    machineName: 'Studio',
    repositoryAddScript: SCRIPT,
    ...options.settings
  }
  const store = {
    getRepos: () => repos,
    getRepo: (id: string) => repos.find((repo) => repo.id === id),
    getProjects: () => projects,
    getSettings: () => settings,
    addRepo: vi.fn(),
    updateRepo: vi.fn()
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these paths read only the catalog and settings members above.
  const runtime = new OrcaRuntimeService(store as never)
  function offer(hostId: ExecutionHostId, repo: Repo): RepositoryAddScriptPreview | undefined {
    if (!repos.some((entry) => entry.id === repo.id)) {
      repos.push(repo)
    }
    const collector = runtime.createRepositoryAddScriptCollector(hostId)
    void collector.onNewGitRepository({ ...repo })
    return collector.previews()[0]
  }
  return {
    runtime,
    store,
    repos,
    projects,
    offer,
    setSettings: (next: Partial<GlobalSettings>) => {
      settings = { ...settings, ...next }
    }
  }
}

function decision(preview: RepositoryAddScriptPreview, choice: 'run' | 'skip' = 'run') {
  return { token: preview.token, hostId: preview.hostId, repoId: preview.repoId, decision: choice }
}

function succeed(): void {
  runner.run.mockImplementation(async (_deps, _run, isAuthorized) => {
    expect(isAuthorized()).toBe(true)
    return { exitCode: 0, output: 'done' }
  })
}

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { ...ORIGINAL_PLATFORM, value: platform })
}

afterEach(() => {
  if (ORIGINAL_PLATFORM) {
    Object.defineProperty(process, 'platform', ORIGINAL_PLATFORM)
  }
  runner.run.mockReset()
  runner.factory.mockClear()
})

describe('runtime repository add scripts', () => {
  it('serves every alias from one catalog-owned service without rebinding the executor', async () => {
    setPlatform('linux')
    succeed()
    const { runtime, offer } = setup()
    const local = offer('local', gitRepo('a'))
    const remote = offer('runtime:env-1', gitRepo('b'))
    expect(local).toMatchObject({
      hostId: 'local',
      hostLabel: 'Studio',
      repoId: 'a',
      target: { kind: 'native', cwd: '/work/a' },
      script: SCRIPT
    })
    expect(remote).toMatchObject({ hostId: 'runtime:env-1', hostLabel: 'Studio', repoId: 'b' })
    if (!local || !remote) {
      throw new Error('expected previews')
    }
    // A preview belongs to the alias it was offered through.
    expect(
      await runtime.decideRepositoryAddScript({ ...decision(remote), hostId: 'local' })
    ).toEqual({ status: 'rejected', reason: 'identity-mismatch' })
    expect(
      runtime.getRepositoryAddScriptOutcome({ ...decision(local), hostId: 'runtime:env-1' })
    ).toBeNull()

    expect(await runtime.decideRepositoryAddScript(decision(remote))).toMatchObject({
      status: 'succeeded'
    })
    const [deps, run] = runner.run.mock.calls[0]
    expect(run.hostId).toBe('runtime:env-1')
    // Exact identity: the remote alias is never rewritten to `local`.
    expect(deps.getExecutorHostId()).toBe('runtime:env-1')
    expect(runtime.getRepositoryAddScriptOutcome(decision(remote))).toMatchObject({
      status: 'succeeded'
    })
  })

  it('shares one registration ledger across aliases and requests', () => {
    setPlatform('linux')
    const { offer } = setup()
    const first = offer('runtime:env-1', gitRepo('a'))
    expect(first).toBeDefined()
    // The same alias asking again gets the same preview; another alias never sees or takes it.
    expect(offer('runtime:env-1', gitRepo('a'))?.token).toBe(first?.token)
    expect(offer('runtime:env-2', gitRepo('a'))).toBeUndefined()
    expect(offer('local', gitRepo('a'))).toBeUndefined()
  })

  it('bounds pending previews across every alias', () => {
    setPlatform('linux')
    const { offer } = setup()
    for (let index = 0; index < 128; index++) {
      const hostId: ExecutionHostId = index % 2 === 0 ? 'local' : `runtime:env-${index % 5}`
      expect(offer(hostId, gitRepo(`r${index}`))).toBeDefined()
    }
    expect(offer('runtime:env-9', gitRepo('overflow'))).toBeUndefined()
  })

  it('stamps the projection only in memory and never writes the stored row', async () => {
    setPlatform('linux')
    succeed()
    const { runtime, store, repos, offer } = setup()
    const preview = offer('runtime:env-1', gitRepo('a'))
    if (!preview) {
      throw new Error('expected preview')
    }
    await runtime.decideRepositoryAddScript(decision(preview))
    expect(repos[0]).toEqual(gitRepo('a'))
    expect(store.updateRepo).not.toHaveBeenCalled()
    expect(store.addRepo).not.toHaveBeenCalled()
  })

  it.each([
    ['a legacy SSH row', gitRepo('a', '/work/a', { executionHostId: null, connectionId: 'box' })],
    ['an SSH-stamped row', gitRepo('a', '/work/a', { executionHostId: 'ssh:box' })],
    [
      'a row stamped for another runtime',
      gitRepo('a', '/work/a', { executionHostId: 'runtime:other' })
    ],
    ['a local row with a stale connection', gitRepo('a', '/work/a', { connectionId: 'box' })],
    ['a folder', gitRepo('a', '/work/a', { kind: 'folder' })]
  ])('offers nothing for %s, whatever alias asks', (_name, repo) => {
    setPlatform('linux')
    const { offer } = setup()
    expect(offer('local', repo)).toBeUndefined()
    expect(offer('runtime:other', repo)).toBeUndefined()
  })

  it.each(['ssh:box', 'runtime:unresolved-owner', 'nonsense'])(
    'refuses the %s alias even for this host’s own row',
    (hostId) => {
      setPlatform('linux')
      const { offer } = setup()
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: deliberately invalid alias from an untrusted caller.
      expect(offer(hostId as ExecutionHostId, gitRepo('a'))).toBeUndefined()
    }
  )

  it('offers nothing when the observed row does not match the stored one', () => {
    setPlatform('linux')
    const { runtime, repos } = setup({ repos: [gitRepo('a')] })
    const collector = runtime.createRepositoryAddScriptCollector('local')
    void collector.onNewGitRepository({ ...repos[0], path: '/elsewhere' })
    void collector.onNewGitRepository(gitRepo('missing'))
    expect(collector.previews()).toEqual([])
  })

  it('revokes approval when the host script changes or is cleared', async () => {
    setPlatform('linux')
    succeed()
    const { runtime, offer, setSettings } = setup()
    const changed = offer('local', gitRepo('a'))
    const cleared = offer('runtime:env-1', gitRepo('b'))
    if (!changed || !cleared) {
      throw new Error('expected previews')
    }
    setSettings({ repositoryAddScript: 'echo different\n' })
    expect(await runtime.decideRepositoryAddScript(decision(changed))).toEqual({ status: 'stale' })
    setSettings({ repositoryAddScript: undefined })
    expect(await runtime.decideRepositoryAddScript(decision(cleared))).toEqual({ status: 'stale' })
    expect(runner.run).not.toHaveBeenCalled()
  })

  it('refuses at spawn time once the stored row leaves this host', async () => {
    setPlatform('linux')
    const { runtime, repos, offer } = setup()
    const preview = offer('local', gitRepo('a'))
    if (!preview) {
      throw new Error('expected preview')
    }
    let seen: ProjectExecutionRuntimeResolution | undefined
    let afterLeaving: unknown = 'not called'
    runner.run.mockImplementation(async (deps, run) => {
      seen = deps.getRuntime(run)
      repos.splice(0, 1, { ...repos[0], executionHostId: 'ssh:box' })
      try {
        afterLeaving = deps.getRuntime(run)
      } catch (error) {
        afterLeaving = error
      }
      return { exitCode: 0, output: '' }
    })
    await runtime.decideRepositoryAddScript(decision(preview))
    expect(seen).toMatchObject({ status: 'resolved', runtime: { kind: 'local-host' } })
    // Never `undefined`: off Windows the runner would read that as this host's native shell.
    expect(afterLeaving).toBeInstanceOf(Error)
  })

  describe('on Windows', () => {
    it('runs natively with the global default for a new repo that has no project', () => {
      setPlatform('win32')
      const { offer } = setup()
      expect(offer('local', gitRepo('a', 'C:\\src\\a'))?.target).toEqual({
        kind: 'native',
        cwd: 'C:\\src\\a'
      })
    })

    it('runs a WSL share path inside its own distro without a project', () => {
      setPlatform('win32')
      const { offer } = setup()
      expect(
        offer('local', gitRepo('a', '\\\\wsl.localhost\\Ubuntu\\home\\me\\a'))?.target
      ).toEqual({ kind: 'wsl', distro: 'Ubuntu', cwd: '/home/me/a' })
    })

    it('routes a drive path through the global default distro', () => {
      setPlatform('win32')
      const { offer } = setup({
        settings: { localWindowsRuntimeDefault: { kind: 'wsl', distro: 'Debian' } }
      })
      expect(offer('runtime:env-1', gitRepo('a', 'C:\\src\\a'))?.target).toEqual({
        kind: 'wsl',
        distro: 'Debian',
        cwd: '/mnt/c/src/a'
      })
    })

    it('refuses a runtime that needs repair instead of falling back to native', () => {
      setPlatform('win32')
      const { offer } = setup({
        settings: { localWindowsRuntimeDefault: { kind: 'wsl', distro: null } }
      })
      expect(offer('local', gitRepo('a', 'C:\\src\\a'))).toBeUndefined()
    })

    it('stales an approval when the project moves the repo into WSL', async () => {
      setPlatform('win32')
      const project: Project = {
        id: 'project-a',
        displayName: 'a',
        badgeColor: '',
        sourceRepoIds: ['a'],
        createdAt: 1,
        updatedAt: 1
      }
      const { runtime, offer, projects } = setup({ projects: [project] })
      const preview = offer('local', gitRepo('a', 'C:\\src\\a'))
      expect(preview?.target).toEqual({ kind: 'native', cwd: 'C:\\src\\a' })
      if (!preview) {
        throw new Error('expected preview')
      }
      projects[0] = { ...project, localWindowsRuntimePreference: { kind: 'wsl', distro: 'Debian' } }
      expect(await runtime.decideRepositoryAddScript(decision(preview))).toEqual({
        status: 'stale'
      })
      expect(runner.run).not.toHaveBeenCalled()
    })

    it('stales an approval once the default runtime needs repair', async () => {
      setPlatform('win32')
      const { runtime, offer, setSettings } = setup()
      const preview = offer('runtime:env-1', gitRepo('a', 'C:\\src\\a'))
      if (!preview) {
        throw new Error('expected preview')
      }
      setSettings({ localWindowsRuntimeDefault: { kind: 'wsl', distro: null } })
      expect(await runtime.decideRepositoryAddScript(decision(preview))).toEqual({
        status: 'stale'
      })
      expect(runner.run).not.toHaveBeenCalled()
    })
  })

  describe('close', () => {
    it('seals at the call: revokes previews and admits no later offer or execution', async () => {
      setPlatform('linux')
      succeed()
      const { runtime, offer } = setup()
      const pending = offer('runtime:env-1', gitRepo('a'))
      if (!pending) {
        throw new Error('expected preview')
      }
      const closed = runtime.closeRepositoryAddScripts()
      expect(runtime.getRepositoryAddScriptOutcome(decision(pending))).toEqual({
        status: 'revoked'
      })
      expect(offer('local', gitRepo('b'))).toBeUndefined()
      expect(await runtime.decideRepositoryAddScript(decision(pending))).toEqual({
        status: 'rejected',
        reason: 'used-token'
      })
      await closed
      expect(runner.factory).not.toHaveBeenCalled()
      expect(runner.run).not.toHaveBeenCalled()
      expect(runtime.hasUnsettledRepositoryAddScriptRuns()).toBe(false)
    })

    it('aborts an active run and still reports a stop it could not verify', async () => {
      setPlatform('linux')
      const { runtime, offer } = setup()
      const preview = offer('local', gitRepo('a'))
      if (!preview) {
        throw new Error('expected preview')
      }
      runner.run.mockImplementation(
        (_deps, _run, _check, signal) =>
          new Promise((resolve) =>
            signal?.addEventListener('abort', () =>
              resolve({ processVerdict: 'unverifiable', output: 'maybe alive' })
            )
          )
      )
      const decided = runtime.decideRepositoryAddScript(decision(preview))
      expect(runtime.hasUnsettledRepositoryAddScriptRuns()).toBe(true)
      await runtime.closeRepositoryAddScripts()
      expect(await decided).toMatchObject({ status: 'unverifiable' })
      // The close settled, but the run was never proven gone.
      expect(runtime.hasUnsettledRepositoryAddScriptRuns()).toBe(true)
    })
  })
})
