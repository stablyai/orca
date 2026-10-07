import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PRRefreshOutcome } from '../../shared/github/pull-request-refresh-types'
import type { Repo } from '../../shared/repo-types'
import type { GitHubRepoContext, LocalGitExecOptions } from './github-repository-identity'
import type { Store } from '../persistence'
import { __resetHostedReviewBranchCacheForTests } from '../source-control/hosted-review-branch-cache'

const mocks = vi.hoisted(() => ({
  resolve: vi.fn(),
  exec: vi.fn(),
  handlers: new Map<string, (event: unknown, args: unknown) => Promise<unknown>>()
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, args: unknown) => Promise<unknown>) =>
      mocks.handlers.set(channel, handler)
  }
}))
vi.mock('./gh-utils', () => ({
  acquire: vi.fn().mockResolvedValue(undefined),
  release: vi.fn(),
  ghExecFileAsync: mocks.exec,
  classifyPullRequestUpdateError: (message: string) => ({ message }),
  classifyGhError: (message: string) => ({ message }),
  githubRepoContext: (
    repoPath: string,
    connectionId: string | null,
    options: LocalGitExecOptions
  ) => ({ repoPath, connectionId, ...options }),
  ghRepoExecOptions: (context: GitHubRepoContext) => context
}))
vi.mock('./github-api-repository', () => ({
  resolveGitHubRepoExecution: vi.fn().mockResolvedValue({
    ownerRepo: { owner: 'acme', repo: 'widgets' },
    ghOptions: {}
  })
}))
vi.mock('./client/lookup/pr-number-lookup', () => ({
  getRestPRByNumber: vi.fn().mockResolvedValue({ stack: null }),
  getPRByNumber: vi.fn().mockResolvedValue(null)
}))
vi.mock('./client/lookup/branch-lookup-resolution', () => ({
  resolvePRForBranchOutcome: mocks.resolve
}))
vi.mock('../providers/ssh-git-dispatch', () => ({ getSshGitProviderGeneration: () => 1 }))
vi.mock('../ipc/github-work-item-mutation-events', () => ({
  broadcastGitHubWorkItemMutation: vi.fn()
}))
vi.mock('../project-runtime-git-options', () => ({ getLocalProjectGhExecOptions: () => ({}) }))

import { getPRForBranchOutcome } from './client/lookup/pr-for-branch-outcome'
import { registerGitHubPRMutationHandlers } from '../ipc/github-pr-mutation-handlers'
import { RuntimeGitHubReviewMutationCommands } from '../runtime/runtime-github-review-mutation-commands'

const local: Repo = { id: 'local', path: '/repo', displayName: 'repo', badgeColor: '', addedAt: 0 }
const ssh: Repo = { ...local, id: 'ssh', connectionId: 'ssh-1' }
const otherSsh: Repo = { ...local, id: 'other-ssh', connectionId: 'ssh-2' }
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: handlers only call getRepos.
const store = { getRepos: () => [local, ssh, otherSsh] } as unknown as Store
registerGitHubPRMutationHandlers(store)
const runtime = new RuntimeGitHubReviewMutationCommands({
  resolveRepo: async (selector) => [local, ssh, otherSsh].find((repo) => repo.id === selector)!,
  getLocalGitArgs: () => []
})

function ipc(channel: string, repo: Repo, args: Record<string, unknown>): Promise<unknown> {
  return mocks.handlers.get(channel)!(
    { sender: { id: 1 } },
    { repoPath: repo.path, repoId: repo.id, ...args }
  )
}

const mutations: { label: string; run: (repo: Repo) => Promise<unknown> }[] = [
  { label: 'IPC merge', run: (repo) => ipc('gh:mergePR', repo, { prNumber: 7 }) },
  {
    label: 'IPC close',
    run: (repo) => ipc('gh:updatePRState', repo, { prNumber: 7, updates: { state: 'closed' } })
  },
  { label: 'IPC ready', run: (repo) => ipc('gh:markPRReadyForReview', repo, { prNumber: 7 }) },
  {
    label: 'IPC auto-merge',
    run: (repo) => ipc('gh:setPRAutoMerge', repo, { prNumber: 7, enabled: false })
  },
  { label: 'IPC title', run: (repo) => ipc('gh:updatePRTitle', repo, { prNumber: 7, title: 'T' }) },
  {
    label: 'IPC reviewers',
    run: (repo) => ipc('gh:requestPRReviewers', repo, { prNumber: 7, reviewers: ['octo'] })
  },
  { label: 'RPC merge', run: (repo) => runtime.mergeRepoPR(repo.id, 7) },
  {
    label: 'RPC reopen',
    run: (repo) => runtime.updateRepoPRState(repo.id, 7, { state: 'open' })
  },
  { label: 'RPC ready', run: (repo) => runtime.markRepoPRReadyForReview(repo.id, 7) },
  { label: 'RPC details', run: (repo) => runtime.updateRepoPRDetails(repo.id, 7, { body: 'B' }) },
  { label: 'RPC reviewers', run: (repo) => runtime.removeRepoPRReviewers(repo.id, 7, ['octo']) }
]

let finishHeld: (value: PRRefreshOutcome) => void = () => {}
const stale: PRRefreshOutcome = { kind: 'no-pr', fetchedAt: 1 }
const fresh: PRRefreshOutcome = { kind: 'no-pr', fetchedAt: 2 }

function holdLookup(repo: Repo): Promise<PRRefreshOutcome> {
  mocks.resolve.mockImplementationOnce(
    () =>
      new Promise<PRRefreshOutcome>((resolve) => {
        finishHeld = resolve
      })
  )
  return getPRForBranchOutcome(repo.path, 'topic', null, repo.connectionId ?? null)
}

beforeEach(() => {
  vi.clearAllMocks()
  __resetHostedReviewBranchCacheForTests()
  mocks.exec.mockResolvedValue({ stdout: '', stderr: '' })
  mocks.resolve.mockResolvedValue(fresh)
})

describe('PR mutation review-lookup fencing', () => {
  it.each(mutations)('$label starts a fresh lookup after success', async ({ run }) => {
    for (const repo of [local, ssh]) {
      mocks.resolve.mockClear()
      const held = holdLookup(repo)
      await vi.waitFor(() => expect(mocks.resolve).toHaveBeenCalledTimes(1))
      expect([true, { ok: true }]).toContainEqual(await run(repo))
      const after = getPRForBranchOutcome(repo.path, 'topic', null, repo.connectionId ?? null)
      finishHeld(stale)
      expect(await Promise.all([held, after])).toEqual([stale, fresh])
      expect(mocks.resolve).toHaveBeenCalledTimes(2)
    }
  })

  it.each(mutations)('$label keeps sharing the in-flight lookup after failure', async ({ run }) => {
    mocks.exec.mockRejectedValue(new Error('denied'))
    const held = holdLookup(local)
    await vi.waitFor(() => expect(mocks.resolve).toHaveBeenCalledTimes(1))
    await run(local)
    const after = getPRForBranchOutcome(local.path, 'topic', null, null)
    finishHeld(stale)
    expect(await Promise.all([held, after])).toEqual([stale, stale])
    expect(mocks.resolve).toHaveBeenCalledTimes(1)
  })

  it('fences only the host that ran the mutation', async () => {
    const heldLocal = holdLookup(local)
    await vi.waitFor(() => expect(mocks.resolve).toHaveBeenCalledTimes(1))
    const finishLocal = finishHeld
    const heldOther = holdLookup(otherSsh)
    await vi.waitFor(() => expect(mocks.resolve).toHaveBeenCalledTimes(2))
    const finishOther = finishHeld
    await runtime.mergeRepoPR(ssh.id, 7)
    await ipc('gh:mergePR', ssh, { prNumber: 7 })
    const afterLocal = getPRForBranchOutcome(local.path, 'topic', null, null)
    const afterOther = getPRForBranchOutcome(otherSsh.path, 'topic', null, 'ssh-2')
    finishLocal(stale)
    finishOther(stale)
    expect(await Promise.all([heldLocal, afterLocal, heldOther, afterOther])).toEqual([
      stale,
      stale,
      stale,
      stale
    ])
    expect(mocks.resolve).toHaveBeenCalledTimes(2)
  })
})
