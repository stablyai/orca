import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as GhUtilsOwner1 from '../../git/command-runner/hosted-cli/gh-exec-file'
import type * as GitRunner from '../../git/command-runner/git-exec-file'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createStore,
  closeTestStores,
  makeRepo,
  testState
} from '../../persistence/persistence-test-harness'
import { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { RpcDispatcher } from '../../runtime/rpc/dispatcher'
import { GITHUB_REPO_WORK_ITEM_METHODS } from '../../runtime/rpc/methods/source-control/github/github-repo-work-item-methods'
import { GITHUB_PULL_REQUEST_METHODS } from '../../runtime/rpc/methods/source-control/github/github-pull-request-methods'
import { registerGitHubWorkItemHandlers } from '../../ipc/source-control/github-work-item-handlers'
import { registerGitHubIssueMutationHandlers } from '../../ipc/source-control/github-issue-mutation-handlers'
import { registerGitHubPRReviewHandlers } from '../../ipc/source-control/github-pr-review-handlers'
import { ghPullRequestsAndWorkItemsApi } from '../../../preload/api/github/gh-bridge-pull-requests-and-work-items'
import { ghMutationsAndProjectsApi } from '../../../preload/api/github/gh-bridge-mutations-and-projects'
import type { GhAccountBinding } from '../../../shared/github/accounts/account-binding'
import { RPC_PARAMS_BY_METHOD } from '../../../shared/rpc-contract/rpc-params-catalog.generated'

const { exec, handle, invoke } = vi.hoisted(() => ({
  exec: vi.fn<typeof GhUtilsOwner1.ghExecFileAsync>(),
  handle: vi.fn<(channel: string, listener: (event: unknown, args: unknown) => unknown) => void>(),
  invoke: vi.fn<(channel: string, args: unknown) => Promise<unknown>>()
}))
vi.mock('../../git/command-runner/hosted-cli/gh-exec-file', async (original) => ({
  ...(await original<typeof GhUtilsOwner1>()),
  ghExecFileAsync: exec
}))
vi.mock('../../git/command-runner/git-exec-file', async (original) => {
  const actual = await original<typeof GitRunner>()
  return {
    ...actual,
    gitExecFileAsync: vi.fn<typeof GitRunner.gitExecFileAsync>(async (args, options) => {
      if (
        options.cwd === '/repo' &&
        args[0] === 'remote' &&
        args[1] === 'get-url' &&
        args[2] === 'origin'
      ) {
        return { stdout: 'https://github.com/acme/widgets.git', stderr: '' }
      }
      return actual.gitExecFileAsync(args, options)
    })
  }
})
vi.mock('electron', () => ({
  ipcMain: { handle },
  ipcRenderer: { invoke },
  app: { isPackaged: false, getPath: () => '/tmp' },
  BrowserWindow: { fromId: () => null, getAllWindows: () => [] },
  webContents: { fromId: () => null, getAllWebContents: () => [] }
}))
vi.mock('../../ipc/ui', () => ({ sendToTrustedUIRenderer: vi.fn() }))
import type { Project } from '../../../shared/project-types'
import type { Repo } from '../../../shared/repo-types'
import { ghRepoExecOptions, githubRepoContext } from '../repositories/github-repository-identity'
import { installGitHubProjectAccounts } from './github-project-account'
import { codeHostReadExecutionScope as githubReadExecutionScope } from '../../source-control/code-host-read-execution-scope'
import { resolveGitHubRepoExecution } from '../repositories/github-api-repository'

let release: (() => void) | undefined
afterEach(() => release?.())
const alice = { host: 'github.com', user: 'Alice' }
const bob = { host: 'github.com', user: 'Bob' }
function repo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo',
    path: '/repo',
    displayName: 'Repo',
    badgeColor: '#000000',
    addedAt: 0,
    ghAccount: alice,
    ...overrides
  }
}
function options(path: string, connectionId?: string | null, extra = {}) {
  return ghRepoExecOptions(githubRepoContext(path, connectionId, extra))
}

it('uses the saved bound or unbound selection over stale caller options, and isolates cache keys', () => {
  let current = repo()
  release = installGitHubProjectAccounts({ getRepos: () => [current] })
  const first = options('/repo', null, { ghAccount: bob })
  expect(first.ghAccount).toEqual(alice)
  current = repo({ ghAccount: bob })
  const second = options('/repo', null, { ghAccount: alice })
  expect(second.ghAccount).toEqual(bob)
  expect(githubReadExecutionScope(first, {})).not.toBe(githubReadExecutionScope(second, {}))
  current = repo({ ghAccount: undefined })
  expect(options('/repo', null, { ghAccount: alice }).ghAccount).toBeUndefined()
  expect(first.ghAccount).toEqual(alice)
})

it.each(['cold', 'warm'] as const)(
  'resolves a %s child worktree by its host-qualified owning project',
  (mode) => {
    const local = repo()
    const remote = repo({ path: '/repo', connectionId: 'server', ghAccount: bob })
    release = installGitHubProjectAccounts(
      {
        getRepos: () => [local, remote],
        getAllWorktreeMetaForHost: (host) =>
          mode === 'cold' && host === 'ssh:server' ? { 'repo::/worktrees/child': {} } : {}
      },
      () =>
        mode === 'warm' ? [{ repoId: 'repo', path: '/worktrees/child', hostId: 'ssh:server' }] : []
    )
    expect(options('/worktrees/child', 'server')).toEqual({ ghAccount: bob })
    expect(options('/worktrees/child')).toEqual({ cwd: '/worktrees/child' })
    expect(options('/repo').ghAccount).toEqual(alice)
    expect(options('/repo', 'server').ghAccount).toEqual(bob)
  }
)

it('selects before an asynchronous repository lookup and retains that account for execution', async () => {
  let current = repo()
  release = installGitHubProjectAccounts({ getRepos: () => [current] })
  let finish: () => void = () => {}
  const waiting = new Promise<void>((resolve) => {
    finish = resolve
  })
  const pending = resolveGitHubRepoExecution('/repo', async () => {
    await waiting
    return { owner: 'acme', repo: 'widgets', host: 'github.com' }
  })
  current = repo({ ghAccount: bob })
  finish()
  expect((await pending).ghOptions.ghAccount).toEqual(alice)
  expect(options('/repo').ghAccount).toEqual(bob)
})

it('derives runtime ownership again after project runtime changes', () => {
  const platform = process.platform
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  try {
    let project: Project = {
      id: 'p',
      displayName: 'Work',
      badgeColor: '#000000',
      createdAt: 0,
      updatedAt: 0,
      sourceRepoIds: ['repo'],
      localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' }
    }
    release = installGitHubProjectAccounts({
      getRepos: () => [repo()],
      getProjects: () => [project],
      getSettings: () => ({})
    })
    expect(options('/repo', null, { wslDistro: 'Ubuntu' }).ghAccount).toEqual(alice)
    expect(options('/repo').ghAccount).toBeUndefined()
    project = { ...project, localWindowsRuntimePreference: { kind: 'windows-host' } }
    expect(options('/repo').ghAccount).toEqual(alice)
    expect(options('/repo', null, { wslDistro: 'Ubuntu' }).ghAccount).toBeUndefined()
  } finally {
    Object.defineProperty(process, 'platform', { configurable: true, value: platform })
  }
})

describe('host account expectation through registered RPC and local preload', () => {
  let store: ReturnType<typeof createStore>
  let dispatcher: RpcDispatcher
  const repository = { host: 'github.com', owner: 'acme', repo: 'widgets' }
  const local = { repoPath: '/repo', repoId: 'repo' }
  const item = { number: 7, type: 'issue' as const, ownerRepo: repository }
  const viewed = { prRepo: repository, pullRequestId: 'PR_7', path: 'same.ts', viewed: true }
  const operations: {
    method:
      | 'github.workItemDetails'
      | 'github.listLabels'
      | 'github.listAssignableUsers'
      | 'github.setPRFileViewed'
    params: Record<string, unknown>
    local: (expectedGhAccount?: GhAccountBinding | null) => Promise<unknown>
  }[] = [
    {
      method: 'github.workItemDetails' as const,
      params: { ...item, canonical: true },
      local: (expectedGhAccount?: GhAccountBinding | null) =>
        ghPullRequestsAndWorkItemsApi.workItemDetails({
          ...local,
          ...item,
          ownerRepo: repository,
          canonical: true,
          expectedGhAccount
        })
    },
    {
      method: 'github.listLabels' as const,
      params: { ownerRepo: repository },
      local: (expectedGhAccount?: GhAccountBinding | null) =>
        ghMutationsAndProjectsApi.listLabels({ ...local, ownerRepo: repository, expectedGhAccount })
    },
    {
      method: 'github.listAssignableUsers' as const,
      params: { ownerRepo: repository },
      local: (expectedGhAccount?: GhAccountBinding | null) =>
        ghMutationsAndProjectsApi.listAssignableUsers({
          ...local,
          ownerRepo: repository,
          expectedGhAccount
        })
    },
    {
      method: 'github.setPRFileViewed' as const,
      params: viewed,
      local: (expectedGhAccount?: GhAccountBinding | null) =>
        ghPullRequestsAndWorkItemsApi.setPRFileViewed({
          ...local,
          ...viewed,
          prNumber: 7,
          expectedGhAccount
        })
    }
  ]
  const dispatch = (
    operation: (typeof operations)[number],
    expectedGhAccount?: GhAccountBinding | null
  ) =>
    dispatcher.dispatch({
      id: 'account',
      authToken: 'fixture',
      method: operation.method,
      params: {
        repo: 'id:repo',
        ...operation.params,
        ...(expectedGhAccount !== undefined ? { expectedGhAccount } : {})
      }
    })
  const applied = (ghAccount: GhAccountBinding | null) =>
    store.updateRepo({ id: 'repo' }, { ghAccount })

  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-pr36172-account-'))
    store = createStore()
    store.addRepo(
      makeRepo({ id: 'repo', path: '/repo', issueSourcePreference: 'origin', ghAccount: alice })
    )
    const runtime = new OrcaRuntimeService(store)
    release = installGitHubProjectAccounts(store)
    vi.spyOn(runtime, 'getRuntimeId').mockReturnValue('account-runtime')
    dispatcher = new RpcDispatcher({
      runtime,
      methods: [...GITHUB_REPO_WORK_ITEM_METHODS, ...GITHUB_PULL_REQUEST_METHODS]
    })
    handle.mockClear()
    registerGitHubWorkItemHandlers(store)
    registerGitHubIssueMutationHandlers(store)
    registerGitHubPRReviewHandlers(store)
    invoke.mockImplementation(async (channel, args) => {
      const listener = handle.mock.calls.find(([name]) => name === channel)?.[1]
      if (!listener) {
        throw new Error('Missing IPC fixture handler')
      }
      return listener({ sender: { id: 7 } }, args)
    })
    exec.mockReset().mockImplementation(async (args, options) => {
      const endpoint = args.find((arg) => arg.startsWith('repos/')) ?? ''
      const viewer = options?.ghAccount?.user ?? 'unbound'
      const issue = {
        number: 7,
        title: viewer,
        state: 'open',
        html_url: 'https://github.com/acme/widgets/issues/7',
        body: viewer,
        labels: [],
        assignees: []
      }
      const output = endpoint.endsWith('/labels')
        ? 'bug'
        : endpoint.includes('/assignees?')
          ? JSON.stringify({ login: viewer, avatar_url: '' })
          : endpoint.includes('/timeline?') || endpoint.includes('/comments?')
            ? '[]'
            : args.includes('graphql')
              ? JSON.stringify({
                  data: {
                    repository: {
                      issue: {
                        ...issue,
                        body: viewer,
                        comments: { nodes: [], pageInfo: { hasNextPage: false } },
                        participants: { nodes: [] },
                        assignees: { nodes: [] }
                      }
                    }
                  }
                })
              : JSON.stringify(issue)
      return { stdout: output, stderr: '' }
    })
  })
  afterEach(async () => {
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('validates all four schemas and rejects mismatches before provider work on RPC and IPC without changing omission', async () => {
    applied(bob)
    for (const operation of operations) {
      const payload = {
        repo: 'id:repo',
        ...operation.params,
        expectedGhAccount: { host: ' GitHub.COM ', user: ' Bob ' }
      }
      expect(RPC_PARAMS_BY_METHOD[operation.method].parse(payload)).toEqual({
        ...payload,
        expectedGhAccount: bob
      })
      for (const malformed of [
        { host: 'github.com' },
        { host: 'bad/host', user: 'Alice' },
        false
      ]) {
        expect(
          RPC_PARAMS_BY_METHOD[operation.method].safeParse({
            ...payload,
            expectedGhAccount: malformed
          }).success
        ).toBe(false)
      }
      exec.mockClear()
      expect(
        await dispatcher.dispatch({
          id: 'malformed',
          authToken: 'fixture',
          method: operation.method,
          params: { ...payload, expectedGhAccount: false }
        })
      ).toMatchObject({ ok: false, error: { code: 'invalid_argument' } })
      expect(exec).not.toHaveBeenCalled()
      expect(await dispatch(operation, alice)).toMatchObject({
        ok: false,
        error: { message: expect.stringContaining('GitHub account changed') }
      })
      expect(exec).not.toHaveBeenCalled()
      await expect(operation.local(alice)).rejects.toThrow('GitHub account changed')
      expect(exec).not.toHaveBeenCalled()
      expect(await dispatch(operation, bob)).toMatchObject({ ok: true })
      expect(exec).toHaveBeenCalled()
      expect(exec.mock.calls.every(([, options]) => options?.ghAccount?.user === 'Bob')).toBe(true)
      exec.mockClear()
      await operation.local(bob)
      expect(exec).toHaveBeenCalled()
      expect(exec.mock.calls.every(([, options]) => options?.ghAccount?.user === 'Bob')).toBe(true)
      exec.mockClear()
      expect(await dispatch(operation)).toMatchObject({ ok: true })
      expect(exec).toHaveBeenCalled()
      expect(exec.mock.calls.every(([, options]) => options?.ghAccount?.user === 'Bob')).toBe(true)
    }
    exec.mockClear()
    expect(await dispatch(operations[1], null)).toMatchObject({ ok: false })
    expect(exec).not.toHaveBeenCalled()
    applied(null)
    expect(await dispatch(operations[1], null)).toMatchObject({ ok: true, result: ['bug'] })
    expect(exec.mock.calls.at(-1)?.[1]?.ghAccount).toBeUndefined()
    await expect(operations[1].local(null)).resolves.toEqual(['bug'])
    expect(exec.mock.calls.at(-1)?.[1]?.ghAccount).toBeUndefined()
    exec.mockClear()
    expect(await dispatch(operations[3], alice)).toMatchObject({ ok: false })
    expect(exec).not.toHaveBeenCalled()
    await expect(
      invoke('gh:listLabels', {
        ...local,
        ownerRepo: repository,
        expectedGhAccount: { user: 'Alice' }
      })
    ).rejects.toThrow('Invalid GitHub account expectation')
    expect(exec).not.toHaveBeenCalled()
    applied(alice)
    expect(await dispatch(operations[0], alice)).toMatchObject({
      ok: true,
      result: { item: { number: 7, type: 'issue' }, body: 'Alice' }
    })
    expect(
      await dispatch({ ...operations[0], params: { ...item, canonical: false } }, alice)
    ).toMatchObject({ ok: true, result: { body: 'Alice' } })
  })

  it('keeps the actual admitted A capture through a later B update for full details and Viewed, then fails a fresh stale-A request', async () => {
    for (const operation of [operations[0], operations[3]]) {
      applied(alice)
      let started: () => void = () => {}
      let finish: () => void = () => {}
      const entered = new Promise<void>((resolve) => {
        started = resolve
      })
      const held = new Promise<void>((resolve) => {
        finish = resolve
      })
      const terminal = exec.getMockImplementation()
      if (!terminal) {
        throw new Error('Missing terminal provider fixture')
      }
      exec.mockImplementationOnce(async (...args) => {
        started()
        await held
        return terminal(...args)
      })
      exec.mockClear()
      const pending = dispatch(operation, alice)
      await entered
      applied(bob)
      finish()
      expect(await pending).toMatchObject({ ok: true })
      expect(exec).toHaveBeenCalled()
      expect(exec.mock.calls.every(([, options]) => options?.ghAccount?.user === 'Alice')).toBe(
        true
      )
      exec.mockClear()
      expect(await dispatch(operation, alice)).toMatchObject({
        ok: false,
        error: { message: expect.stringContaining('GitHub account changed') }
      })
      expect(exec).not.toHaveBeenCalled()
    }
  })
})
