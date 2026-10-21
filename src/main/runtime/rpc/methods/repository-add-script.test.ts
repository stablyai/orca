import '../unused-default-rpc-methods.test-fixture'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { Repo } from '../../../../shared/repo-types'
import type { RepositoryAddScriptExecutionResult } from '../../../../shared/repository-add-script-types'
import type * as RunnerModule from '../../../repository-add-scripts/repository-add-script-runner'
import type { RepositoryAddScriptRunnerDependencies } from '../../../repository-add-scripts/repository-add-script-runner'
import type {
  RepositoryAddScriptAuthorizationCheck,
  RepositoryAddScriptRun
} from '../../../repository-add-scripts/repository-add-script-service'

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
vi.mock('../../../repository-add-scripts/repository-add-script-runner', async (importOriginal) => ({
  ...(await importOriginal<typeof RunnerModule>()),
  createRepositoryAddScriptRunner: runner.factory
}))
vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

import { RpcDispatcher } from '../dispatcher'
import { OrcaRuntimeService } from '../../orca-runtime'
import { REPO_METHODS } from './repo'
import { REPOSITORY_ADD_SCRIPT_METHODS } from './repository-add-script'
import { MOBILE_RPC_METHOD_ALLOWLIST } from '../../runtime-rpc/runtime-rpc-mobile-method-allowlist'
import {
  offerIdentityIn,
  offeredRepoIdsIn,
  okResultOf
} from '../../../repository-add-scripts/repository-add-script-wire-readers.test-fixture'
import type { ProjectHostSetupResult } from '../../../../shared/project-types'

const ORIGINAL_PLATFORM = Object.getOwnPropertyDescriptor(process, 'platform')
const SCRIPT = 'echo prepared\n'

function gitRow(id: string, extra: Partial<Repo> = {}): Repo {
  return {
    id,
    path: `/work/${id}`,
    displayName: id,
    badgeColor: '',
    addedAt: 1,
    kind: 'git',
    executionHostId: 'local',
    ...extra
  }
}

function setupResult(repo: Repo): ProjectHostSetupResult {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the RPC layer only spreads this result and reads only its repo.
  return { project: {}, setup: {}, repo } as never
}

function setup(repos: Repo[] = []) {
  const settings: Partial<GlobalSettings> = { machineName: 'Studio', repositoryAddScript: SCRIPT }
  const store = {
    getRepos: () => repos,
    getRepo: (id: string) => repos.find((repo) => repo.id === id),
    getProjects: () => [],
    getSettings: () => settings,
    addRepo: vi.fn(),
    updateRepo: vi.fn()
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these paths read only the catalog and settings members above.
  const runtime = new OrcaRuntimeService(store as never)
  const collectorSpy = vi.spyOn(runtime, 'createRepositoryAddScriptCollector')
  // The controllers are covered elsewhere; here they only report the row a request inserted.
  const insert = (row: Repo, observer?: (repo: Repo) => unknown): Repo => {
    repos.push(row)
    void observer?.({ ...row })
    return row
  }
  const dispatcher = new RpcDispatcher({
    runtime,
    methods: [...REPO_METHODS, ...REPOSITORY_ADD_SCRIPT_METHODS]
  })
  const call = (method: string, params?: unknown) =>
    dispatcher.dispatch({ id: 'req', authToken: 'tok', method, params })
  return { runtime, repos, collectorSpy, insert, call }
}

afterEach(() => {
  if (ORIGINAL_PLATFORM) {
    Object.defineProperty(process, 'platform', ORIGINAL_PLATFORM)
  }
  runner.run.mockReset()
  runner.factory.mockClear()
})

function linux(): void {
  Object.defineProperty(process, 'platform', { ...ORIGINAL_PLATFORM, value: 'linux' })
}

describe('repository add script RPC', () => {
  it('offers a new Git row only to the request that opted in, then runs the approved token once', async () => {
    linux()
    runner.run.mockResolvedValue({ exitCode: 0, output: 'done' })
    const { runtime, insert, call } = setup()
    vi.spyOn(runtime, 'addRepo').mockImplementation(async (path, _kind, _host, _name, observer) =>
      insert(gitRow('a', { path }), observer)
    )

    const response = await call('repo.add', {
      path: '/work/a',
      repositoryAddScriptPreview: { hostId: 'runtime:env-1' }
    })

    expect(response).toMatchObject({
      ok: true,
      result: {
        repo: { id: 'a' },
        repositoryAddScriptPreview: { hostId: 'runtime:env-1', repoId: 'a', script: SCRIPT }
      }
    })
    const preview = offerIdentityIn(okResultOf(response))
    const decision = {
      token: preview.token,
      hostId: 'runtime:env-1',
      repoId: preview.repoId,
      decision: 'run'
    }

    await expect(call('repositoryAddScript.decide', decision)).resolves.toMatchObject({
      ok: true,
      result: { result: { status: 'succeeded', exitCode: 0 } }
    })
    await expect(call('repositoryAddScript.decide', decision)).resolves.toMatchObject({
      ok: true,
      result: { result: { status: 'rejected', reason: 'used-token' } }
    })
    expect(runner.run).toHaveBeenCalledTimes(1)
    await expect(
      call('repositoryAddScript.outcome', {
        token: preview.token,
        hostId: 'runtime:env-1',
        repoId: preview.repoId
      })
    ).resolves.toMatchObject({ ok: true, result: { outcome: { status: 'succeeded' } } })
  })

  it('creates no collector and returns the legacy shape without the opt-in', async () => {
    linux()
    const { runtime, insert, collectorSpy, call } = setup()
    const add = vi
      .spyOn(runtime, 'addRepo')
      .mockImplementation(async (path, _kind, _host, _name, observer) =>
        insert(gitRow('a', { path }), observer)
      )

    const response = await call('repo.add', { path: '/work/a' })

    expect(collectorSpy).not.toHaveBeenCalled()
    expect(add.mock.calls[0]?.[4]).toBeUndefined()
    expect(response).toMatchObject({ ok: true, result: { repo: { id: 'a' } } })
    expect(Object.keys(okResultOf(response))).toEqual(['repo'])
  })

  it('leaves the preview key off when nothing new was inserted', async () => {
    linux()
    const known = gitRow('known')
    const { runtime, collectorSpy, call } = setup([known])
    vi.spyOn(runtime, 'addRepo').mockResolvedValue(known)

    const response = await call('repo.add', {
      path: known.path,
      repositoryAddScriptPreview: { hostId: 'local' }
    })

    expect(collectorSpy).toHaveBeenCalledTimes(1)
    expect(Object.keys(okResultOf(response))).toEqual(['repo'])
  })

  it('offers nothing for a folder registration', async () => {
    linux()
    const { runtime, insert, call } = setup()
    vi.spyOn(runtime, 'addRepo').mockImplementation(async (path, _kind, _host, _name, observer) =>
      insert(gitRow('f', { path, kind: 'folder' }), observer)
    )

    const response = await call('repo.add', {
      path: '/work/f',
      kind: 'folder',
      repositoryAddScriptPreview: { hostId: 'local' }
    })

    expect(Object.keys(okResultOf(response))).toEqual(['repo'])
  })

  it.each([
    ['an SSH alias', { hostId: 'ssh:box-1' }],
    ['a non-canonical spelling', { hostId: ' local' }],
    ['an unresolved owner', { hostId: 'runtime:unresolved-owner' }],
    ['an empty runtime alias', { hostId: 'runtime:' }],
    ['a missing host', {}],
    ['an extra field', { hostId: 'local', script: 'rm -rf /' }],
    ['a boolean', true]
  ])('rejects %s before registering anything', async (_label, flag) => {
    linux()
    const { runtime, collectorSpy, call } = setup()
    const add = vi.spyOn(runtime, 'addRepo')

    const response = await call('repo.add', { path: '/work/a', repositoryAddScriptPreview: flag })

    expect(response).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    expect(add).not.toHaveBeenCalled()
    expect(collectorSpy).not.toHaveBeenCalled()
  })

  it('wraps repo.create and repo.clone results with the preview, keeping the error branch bare', async () => {
    linux()
    const { runtime, insert, call } = setup()
    vi.spyOn(runtime, 'createRepo').mockImplementation(async (parentPath, name, _kind, observer) =>
      name === 'bad'
        ? { error: 'nope' }
        : { repo: insert(gitRow('c', { path: parentPath }), observer) }
    )
    vi.spyOn(runtime, 'cloneRepo').mockImplementation(async (_url, destination, _host, observer) =>
      insert(gitRow('d', { path: destination }), observer)
    )
    const flag = { repositoryAddScriptPreview: { hostId: 'local' } }

    await expect(
      call('repo.create', { parentPath: '/work', name: 'c', ...flag })
    ).resolves.toMatchObject({
      result: { repo: { id: 'c' }, repositoryAddScriptPreview: { repoId: 'c' } }
    })
    const failed = await call('repo.create', { parentPath: '/work', name: 'bad', ...flag })
    expect(okResultOf(failed)).toEqual({ error: 'nope' })
    await expect(
      call('repo.clone', { url: 'https://example.com/d.git', destination: '/work/d', ...flag })
    ).resolves.toMatchObject({
      result: { repo: { id: 'd' }, repositoryAddScriptPreview: { repoId: 'd' } }
    })
  })

  it('returns one preview per row a nested import inserted, beside the unchanged projects list', async () => {
    linux()
    const { runtime, insert, call } = setup([gitRow('known')])
    vi.spyOn(runtime, 'importNestedRepos').mockImplementation(async (_args, observer) => {
      insert(gitRow('n1'), observer)
      insert(gitRow('n2'), observer)
      return {
        projects: [
          { path: '/work/n1', projectId: 'n1', status: 'imported' },
          { path: '/work/n2', projectId: 'n2', status: 'imported' },
          { path: '/work/known', projectId: 'known', status: 'already-known' }
        ],
        importedCount: 2,
        alreadyKnownCount: 1,
        failedCount: 0
      }
    })

    const response = await call('projectGroup.importNested', {
      parentPath: '/work',
      projectPaths: ['/work/n1', '/work/n2', '/work/known'],
      mode: 'separate',
      repositoryAddScriptPreview: { hostId: 'local' }
    })

    const result = okResultOf(response)
    expect(result.projects).toHaveLength(3)
    expect(offeredRepoIdsIn(result).sort()).toEqual(['n1', 'n2'])
    expect(JSON.stringify(result.projects)).not.toContain('repositoryAddScript')
  })

  it('keeps the offer alias separate from the rewritten setup host on setupExistingFolder and clone', async () => {
    linux()
    const { runtime, insert, call } = setup()
    const existing = vi
      .spyOn(runtime, 'setupProjectExistingFolder')
      .mockImplementation(async (_args, observer) => setupResult(insert(gitRow('s1'), observer)))
    const clone = vi
      .spyOn(runtime, 'setupProjectClone')
      .mockImplementation(async (_args, observer) => setupResult(insert(gitRow('s2'), observer)))
    const alias = { repositoryAddScriptPreview: { hostId: 'runtime:env-9' } }

    const first = await call('projectHostSetup.setupExistingFolder', {
      projectId: 'p',
      hostId: 'runtime:env-9',
      path: '/work/s1',
      ...alias
    })
    const second = await call('projectHostSetup.clone', {
      projectId: 'p',
      hostId: 'runtime:env-9',
      url: 'https://example.com/s2.git',
      destination: '/work',
      ...alias
    })

    expect(existing.mock.calls[0]?.[0]).toMatchObject({ hostId: 'local' })
    expect(existing.mock.calls[0]?.[0]).not.toHaveProperty('repositoryAddScriptPreview')
    expect(clone.mock.calls[0]?.[0]).not.toHaveProperty('repositoryAddScriptPreview')
    expect(first).toMatchObject({
      result: {
        result: { repo: { id: 's1' }, repositoryAddScriptPreview: { hostId: 'runtime:env-9' } }
      }
    })
    expect(second).toMatchObject({
      result: { result: { repositoryAddScriptPreview: { repoId: 's2', hostId: 'runtime:env-9' } } }
    })
  })

  describe('decide and outcome', () => {
    const identity = { token: 't', hostId: 'local', repoId: 'r' }

    it.each([
      ['an extra script field', { ...identity, decision: 'run', script: 'echo hi' }],
      ['an extra path field', { ...identity, decision: 'run', path: '/work/r' }],
      ['an extra target field', { ...identity, decision: 'run', target: { kind: 'native' } }],
      ['an unknown decision', { ...identity, decision: 'always' }],
      ['an SSH host', { ...identity, hostId: 'ssh:box', decision: 'run' }],
      ['a blank token', { ...identity, token: '', decision: 'run' }]
    ])('refuses decide with %s', async (_label, params) => {
      const { call } = setup()
      const response = await call('repositoryAddScript.decide', params)
      expect(response).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    })

    it('refuses an outcome read that carries anything but the identity', async () => {
      const { call } = setup()
      const response = await call('repositoryAddScript.outcome', { ...identity, decision: 'run' })
      expect(response).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
    })

    it('answers an unknown identity with a null outcome and a rejected decision', async () => {
      linux()
      const { call } = setup()
      await expect(call('repositoryAddScript.outcome', identity)).resolves.toMatchObject({
        ok: true,
        result: { outcome: null }
      })
      await expect(
        call('repositoryAddScript.decide', { ...identity, decision: 'run' })
      ).resolves.toMatchObject({
        ok: true,
        result: { result: { status: 'rejected', reason: 'invalid-token' } }
      })
      expect(runner.run).not.toHaveBeenCalled()
    })

    it('uses workspace scope and exposes no offer, list or revoke method', () => {
      expect(
        REPOSITORY_ADD_SCRIPT_METHODS.map((method) => [method.name, method.permission])
      ).toEqual([
        ['repositoryAddScript.decide', 'workspace'],
        ['repositoryAddScript.outcome', 'workspace']
      ])
    })

    it('stays off the mobile allowlist, with every registration method that can carry an offer', () => {
      for (const method of [
        'repositoryAddScript.decide',
        'repositoryAddScript.outcome',
        'repo.add',
        'repo.create',
        'repo.clone',
        'projectGroup.importNested',
        'projectHostSetup.setupExistingFolder',
        'projectHostSetup.clone'
      ]) {
        expect(MOBILE_RPC_METHOD_ALLOWLIST.has(method), method).toBe(false)
      }
    })
  })
})
