import type { createGitHubPullRequest } from '../client/create/create-github-pull-request'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFakeSpawnedChild } from '../../../shared/__fixtures__/fake-spawned-child'
import {
  createStore,
  closeTestStores,
  testState,
  makeRepo
} from '../../persistence/persistence-test-harness'

const { spawnMock, remote } = vi.hoisted(() => ({ spawnMock: vi.fn(), remote: vi.fn() }))
vi.mock('node:child_process', async (original) => ({ ...(await original()), spawn: spawnMock }))
vi.mock('../repositories/github-api-repository-remote-probe', () => ({
  getOriginGitHubApiRepository: remote,
  getGitHubApiRepositoryForRemote: remote
}))
vi.mock('../../git/remotes/remote-name-listing', () => ({
  shouldProbeGitRemote: async () => false
}))
vi.mock('../api/rate-limit', () => ({
  repositoryRateLimitGuard: () => ({ blocked: false }),
  noteRepositoryRateLimitSpend: () => {},
  spendsSharedGitHubComQuota: () => false
}))
vi.mock('../client/list/work-item-search-page', () => ({ usesGraphqlWorkItemSearch: () => false }))
vi.mock('../client/lookup/pr-lookup-rate-limit', () => ({ assertRateLimitBudget: async () => {} }))

vi.mock('../../source-control/forge-provider-detection', () => ({
  detectHostedReviewProvider: async () => 'github',
  getForgeProviderForRepository: async () => ({
    id: 'github',
    getReviewForBranch: async () => null,
    createReview: async (...args: Parameters<typeof createGitHubPullRequest>) =>
      (await import('../client/create/create-github-pull-request')).createGitHubPullRequest(...args)
  })
}))
vi.mock('../../source-control/hosted-review-creation-git-state', async (original) => ({
  ...(await original()),
  getCurrentBranch: async () => 'feature',
  hasUncommittedChanges: async () => false,
  getHostedReviewUpstreamStatus: async () => ({ hasUpstream: true, ahead: 0, behind: 0 }),
  baseRefExistsOnRemote: async () => true,
  getDefaultBaseRef: async () => 'parent'
}))
vi.mock('../../source-control/hosted-review-creation-provider', async (original) => ({
  ...(await original()),
  isProviderAuthenticated: async () => true
}))

import { installGitHubProjectAccounts } from './github-project-account'
import { getPRChecks } from '../client/check/get-pr-checks'

import { getPRFileContents } from '../pull-requests/files/pull-request-file-contents'
import '../pull-requests/start-points/pr-start-point'
import '../../runtime/integrations/github/runtime-github-repository-query-commands'
import { clearGhAccountTokenCacheForTests } from './gh-account-token'
import { clearGhCapabilityStateForTests } from './gh-capability-state'
import { _resetGhRateLimitBreaker } from '../../git/command-runner/hosted-cli/gh-rate-limit-breaker'
import { getPRForBranchOutcome } from '../client/lookup/pr-for-branch-outcome'

import '../pull-requests/refresh/pr-refresh-candidate-policy'
import { fetchPullRequestWorkItem } from '../client/fetch/work-item-fetch'
import { repositoryMergeMetadataCache } from '../client/detect/repository-merge-metadata-cache'
import { _resetPRStackSummaryCacheForTests } from '../client/lookup/pr-stack-summary-cache'
import { _resetGitHubPRStackCacheForTests } from '../pull-requests/stacks/github-pr-stack'
import { resetMergedPRCommitMembershipCacheForTest } from '../pull-requests/refresh/merged-pr-commit-membership'
import '../repositories/github-repository-identity'

const alice = { host: 'github.com', user: 'Alice' }
const bob = { host: 'github.com', user: 'Bob' }
const repository = { host: 'github.com', owner: 'acme', repo: 'widgets' }
let store: ReturnType<typeof createStore>
let release: () => void
let onRead: () => void
let requests: { args: string[]; token: string | undefined }[]
let request: (
  args: string[],
  child: ReturnType<typeof createFakeSpawnedChild>,
  token?: string
) => void
function complete(child: ReturnType<typeof createFakeSpawnedChild>, stdout: string) {
  child.stdout?.emit('data', Buffer.from(stdout))
  child.emit('exit', 0, null)
  child.emit('close', 0, null)
}
function checkResponse(name = 'CI') {
  return JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          commits: {
            nodes: [
              {
                commit: {
                  statusCheckRollup: {
                    contexts: {
                      nodes: [
                        {
                          __typename: 'CheckRun',
                          name,
                          status: 'COMPLETED',
                          conclusion: 'FAILURE',
                          databaseId: 7,
                          checkSuite: { workflowRun: { databaseId: 99 } }
                        }
                      ]
                    }
                  }
                }
              }
            ]
          }
        }
      }
    }
  })
}

function pr(title: string) {
  return {
    number: 42,
    title,
    state: 'OPEN',
    url: 'https://github.com/acme/widgets/pull/42',
    headRefName: 'feature',
    baseRefName: 'main',
    headRepositoryOwner: { login: 'acme' },
    headRepository: { name: 'widgets' },
    statusCheckRollup: [],
    mergeable: 'MERGEABLE'
  }
}
function rebind() {
  store.updateRepo({ id: 'work' }, { ghAccount: bob })
}
function rebindDuringFirstResolution() {
  let first = true
  onRead = () => {
    if (first) {
      first = false
      queueMicrotask(rebind)
    }
  }
}
beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-pr35023-'))
  const original = createStore()
  original.addRepo(makeRepo({ id: 'work', path: '/work', issueSourcePreference: 'origin' }))
  original.updateRepo({ id: 'work' }, { ghAccount: { host: ' GitHub.COM ', user: ' Alice ' } })
  original.flush()
  store = createStore()
  expect(store.getRepo('work')?.ghAccount).toEqual(alice)
  clearGhAccountTokenCacheForTests()
  clearGhCapabilityStateForTests()
  _resetGhRateLimitBreaker()
  repositoryMergeMetadataCache.clear()
  _resetPRStackSummaryCacheForTests()
  _resetGitHubPRStackCacheForTests()
  resetMergedPRCommitMembershipCacheForTest()
  requests = []
  onRead = () => {}
  release = installGitHubProjectAccounts({
    getRepos: () => {
      onRead()
      return store.getRepos()
    }
  })
  remote.mockReset().mockResolvedValue(repository)
  request = (args, child) =>
    queueMicrotask(() => complete(child, args.includes('POST') ? '{}' : checkResponse()))
  spawnMock
    .mockReset()
    .mockImplementation((_command, args: string[], options: { env: NodeJS.ProcessEnv }) => {
      const child = createFakeSpawnedChild()
      if (args[0] === 'auth') {
        queueMicrotask(() =>
          complete(
            child,
            args.includes('--help') ? '--user' : `${args[args.indexOf('--user') + 1]}-token`
          )
        )
      } else {
        requests.push({ args, token: options.env.GH_TOKEN })
        request(args, child, options.env.GH_TOKEN)
      }
      return child
    })
})
afterEach(async () => {
  release()
  vi.unstubAllEnvs()
  _resetGhRateLimitBreaker()
  await closeTestStores()
  rmSync(testState.dir, { recursive: true, force: true })
})

it('separates unresolved callers by saved account before coalescing and returns each account result', async () => {
  let finish: () => void = () => {}
  let started: () => void = () => {}
  const dispatched = new Promise<void>((resolve) => {
    started = resolve
  })
  request = (_args, child, token) => {
    if (token === 'Alice-token') {
      finish = () => complete(child, checkResponse('Alice CI'))
      started()
    } else {
      queueMicrotask(() => complete(child, checkResponse('Bob CI')))
    }
  }
  const first = getPRChecks('/work', 42, undefined, repository)
  await dispatched
  rebind()
  const second = getPRChecks('/work', 42, undefined, repository)
  // Bob must settle independently while Alice's child is still pending.
  await expect(second).resolves.toMatchObject([{ name: 'Bob CI', workflowRunId: 99 }])
  finish()
  await expect(first).resolves.toMatchObject([{ name: 'Alice CI', workflowRunId: 99 }])
  expect(requests.map((r) => r.token)).toEqual(['Alice-token', 'Bob-token'])
})

it('loads both file versions under one saved selection across repository resolution and future rebind', async () => {
  rebindDuringFirstResolution()
  request = (args, child, token) =>
    queueMicrotask(() =>
      complete(child, `${token}:${args.some((arg) => arg.includes('ref=base')) ? 'base' : 'head'}`)
    )
  const input = {
    repoPath: '/work',
    prRepo: repository,
    prNumber: 42,
    path: 'src/a.ts',
    status: 'modified',
    headSha: 'head',
    baseSha: 'base'
  } as const
  await expect(getPRFileContents(input)).resolves.toMatchObject({
    original: 'Alice-token:base',
    modified: 'Alice-token:head',
    originalIsBinary: false,
    modifiedIsBinary: false
  })
  await expect(getPRFileContents(input)).resolves.toMatchObject({
    original: 'Bob-token:base',
    modified: 'Bob-token:head'
  })
})

it('returns each saved viewer merge preference with omitted detector scope and reuses only that viewer', async () => {
  request = (args, child, token) =>
    queueMicrotask(() =>
      complete(
        child,
        JSON.stringify(
          args.includes('graphql')
            ? {
                data: {
                  repository: {
                    viewerDefaultMergeMethod: token === 'Alice-token' ? 'MERGE' : 'SQUASH',
                    mergeCommitAllowed: true,
                    rebaseMergeAllowed: true,
                    squashMergeAllowed: true
                  }
                }
              }
            : pr(token ?? 'ambient')
        )
      )
    )
  const read = () => fetchPullRequestWorkItem('/work', repository, 42)
  await expect(read()).resolves.toMatchObject({
    title: 'Alice-token',
    mergeMethodSettings: { defaultMethod: 'merge' }
  })
  await expect(read()).resolves.toMatchObject({ mergeMethodSettings: { defaultMethod: 'merge' } })
  rebind()
  await expect(read()).resolves.toMatchObject({
    title: 'Bob-token',
    mergeMethodSettings: { defaultMethod: 'squash' }
  })
  await expect(read()).resolves.toMatchObject({ mergeMethodSettings: { defaultMethod: 'squash' } })
  expect(requests.filter((r) => r.args.includes('graphql')).map((r) => r.token)).toEqual([
    'Alice-token',
    'Bob-token'
  ])
})

it('recovers visible merged review through Bob complete membership iteration after Alice error and reuses Bob confirmation', async () => {
  request = (args, child, token) =>
    queueMicrotask(() => {
      const membership = args.find((arg) => arg.includes('/commits/') && arg.includes('/pulls?'))
      if (membership && token === 'Alice-token') {
        child.stderr?.emit('data', Buffer.from('request failed'))
        child.emit('exit', 1, null)
        child.emit('close', 1, null)
        return
      }
      const merged = { ...pr(token ?? 'ambient'), state: 'MERGED', headRefOid: 'aaaa1111aaaa1111' }
      const restMerged = {
        number: 42,
        title: token,
        state: 'closed',
        merged_at: '2026-10-01T00:00:00Z',
        html_url: merged.url,
        head: {
          ref: 'feature',
          sha: 'aaaa1111aaaa1111',
          repo: { name: 'widgets', owner: { login: 'acme' } }
        },
        base: { ref: 'main' }
      }
      const output = membership
        ? membership.endsWith('page=1')
          ? Array.from({ length: 100 }, (_, i) => ({ number: 1000 + i }))
          : [{ number: 42 }]
        : args.includes('graphql')
          ? { data: { repository: {} } }
          : args.some((arg) => arg.includes('/pulls?'))
            ? [restMerged]
            : args[1] === 'list'
              ? [merged]
              : merged
      complete(
        child,
        (args.includes('--include') ? 'HTTP/2.0 200 OK\r\n\r\n' : '') + JSON.stringify(output)
      )
    })
  const read = () =>
    getPRForBranchOutcome('/work', 'feature', null, null, null, {
      currentHeadOid: 'bbbb2222bbbb2222'
    })
  await expect(read()).resolves.toMatchObject({ kind: 'no-pr' })
  rebind()
  await expect(read()).resolves.toMatchObject({
    kind: 'found',
    pr: { title: 'Bob-token', state: 'merged', confirmedContainedHeadOid: 'bbbb2222bbbb2222' }
  })
  await expect(read()).resolves.toMatchObject({
    kind: 'found',
    pr: { confirmedContainedHeadOid: 'bbbb2222bbbb2222' }
  })
  expect(
    requests
      .filter((r) => r.args.some((arg) => arg.includes('/commits/') && arg.includes('/pulls?')))
      .map((r) => ({
        endpoint: r.args.find((arg) => arg.includes('/commits/') && arg.includes('/pulls?')),
        token: r.token
      }))
  ).toEqual([
    {
      endpoint: 'repos/acme/widgets/commits/bbbb2222bbbb2222/pulls?per_page=100&page=1',
      token: 'Alice-token'
    },
    {
      endpoint: 'repos/acme/widgets/commits/bbbb2222bbbb2222/pulls?per_page=100&page=1',
      token: 'Bob-token'
    },
    {
      endpoint: 'repos/acme/widgets/commits/bbbb2222bbbb2222/pulls?per_page=100&page=2',
      token: 'Bob-token'
    }
  ])
})
