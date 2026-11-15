import type { Mock } from 'vitest'
import { completePRCheckGraphQLResponse } from '../../../shared/github/checks/complete-pr-check-test-fixture'
import type { GitHubClientMocks } from './client-test-mocks'
import { _resetOwnerRepoCache } from '../repositories/github-repository-identity'
import { _resetMergeQueueCacheForTests } from './detect/repository-merge-metadata-cache'
import { _resetPRStackSummaryCacheForTests } from './lookup/pr-stack-summary-cache'
import { __resetTrackedUpstreamBranchCacheForTests } from './lookup/tracked-upstream-cache'
import { __resetPRConflictSummaryCachesForTests } from '../pull-requests/conflicts/conflict-summary'
import { resetMergedPRCommitMembershipCacheForTest } from '../pull-requests/refresh/merged-pr-commit-membership'
import { __resetRepoDefaultBranchCacheForTests } from '../../source-control/repo-default-branch'
import { _resetOriginGitHubApiRepositoryCache } from '../repositories/github-api-repository-remote-probe'
import { _resetGitHubPRStackCacheForTests } from '../pull-requests/stacks/github-pr-stack'

export function resetOriginRepositoryCache(): void {
  _resetOriginGitHubApiRepositoryCache()
}

export function resetPRForBranchMocks(mocks: GitHubClientMocks): void {
  resetOriginRepositoryCache()
  mocks.execFileAsyncMock.mockReset()
  mocks.ghExecFileAsyncMock.mockReset()
  mocks.getOwnerRepoMock.mockReset()
  mocks.getIssueOwnerRepoMock.mockReset()
  mocks.getOwnerRepoForRemoteMock.mockReset()
  // Route origin probes through the suite's repository fixture.
  mocks.getOwnerRepoForRemoteMock.mockImplementation(
    async (repoPath: string, remoteName: string, connectionId?: string | null, opts = {}) =>
      remoteName === 'origin' ? mocks.getOwnerRepoMock(repoPath, connectionId, opts) : null
  )
  mocks.resolvePRRepositoryCandidatesMock.mockReset()
  mocks.resolvePRRepositoryCandidatesMock.mockImplementation(async (repoPath, connectionId) => {
    const origin = await mocks.getOwnerRepoMock(repoPath, connectionId)
    return { candidates: origin ? [origin] : [], headRepo: origin }
  })
  mocks.getRemoteUrlForRepoMock.mockReset()
  mocks.gitExecFileAsyncMock.mockReset()
  mocks.getRateLimitMock.mockReset()
  mocks.getRateLimitMock.mockResolvedValue({ resources: {} })
  mocks.rateLimitGuardMock.mockReset()
  mocks.rateLimitGuardMock.mockReturnValue({ blocked: false })
  mocks.noteRateLimitSpendMock.mockReset()
  mocks.ghRepoExecOptionsMock.mockClear()
  mocks.githubRepoContextMock.mockClear()
  mocks.readLocalGitConfigSignatureMock.mockReset()
  mocks.readLocalGitConfigSignatureMock.mockResolvedValue(undefined)
  mocks.acquireMock.mockReset()
  mocks.releaseMock.mockReset()
  mocks.acquireMock.mockResolvedValue(undefined)
  _resetOwnerRepoCache()
  _resetMergeQueueCacheForTests()
  _resetPRStackSummaryCacheForTests()
  _resetGitHubPRStackCacheForTests()
  __resetTrackedUpstreamBranchCacheForTests()
  __resetPRConflictSummaryCachesForTests()
  resetMergedPRCommitMembershipCacheForTest()
  __resetRepoDefaultBranchCacheForTests()
}

export function resetGraphQLRateLimitGuardMocks(mocks: GitHubClientMocks): void {
  resetOriginRepositoryCache()
  mocks.execFileAsyncMock.mockReset()
  mocks.ghExecFileAsyncMock.mockReset()
  mocks.getOwnerRepoMock.mockReset()
  mocks.getIssueOwnerRepoMock.mockReset()
  mocks.getOwnerRepoForRemoteMock.mockReset()
  mocks.getOwnerRepoForRemoteMock.mockImplementation(
    async (repoPath: string, remoteName: string, connectionId?: string | null, opts = {}) =>
      remoteName === 'origin' ? mocks.getOwnerRepoMock(repoPath, connectionId, opts) : null
  )
  mocks.resolvePRRepositoryCandidatesMock.mockReset()
  mocks.resolvePRRepositoryCandidatesMock.mockImplementation(async (repoPath, connectionId) => {
    const origin = await mocks.getOwnerRepoMock(repoPath, connectionId)
    return { candidates: origin ? [origin] : [], headRepo: origin }
  })
  mocks.getRemoteUrlForRepoMock.mockReset()
  mocks.gitExecFileAsyncMock.mockReset()
  mocks.rateLimitGuardMock.mockReset()
  mocks.rateLimitGuardMock.mockReturnValue({ blocked: false })
  mocks.noteRateLimitSpendMock.mockReset()
  mocks.acquireMock.mockReset()
  mocks.releaseMock.mockReset()
  mocks.acquireMock.mockResolvedValue(undefined)
  _resetOwnerRepoCache()
  _resetMergeQueueCacheForTests()
  _resetPRStackSummaryCacheForTests()
  __resetPRConflictSummaryCachesForTests()
}

export function mockPRLookupRoutes(
  mocks: GitHubClientMocks,
  routes: [string, () => Promise<{ stdout: string }>][],
  unavailableChecks = false,
  unexpectedRequests: string[][] = [],
  contexts: Record<string, unknown>[] = []
): void {
  const { ghExecFileAsyncMock } = mocks
  const metadata = new Map<string, Record<string, unknown>>()
  ghExecFileAsyncMock.mockImplementation(async (args: string[]) => {
    const repo = args[args.indexOf('--repo') + 1]
    const key =
      args[0] === 'pr'
        ? args[1] === 'view'
          ? `view:${repo}:${args[2]}`
          : `list:${repo}:${args[args.indexOf('--head') + 1]}`
        : args[1]
    const index = routes.findIndex(([route]) => route === key)
    if (index !== -1) {
      const [, respond] = routes.splice(index, 1)[0]!
      const result = await respond()
      if (args[0] === 'pr' && args[1] === 'view') {
        metadata.set(`${repo}:${args[2]}`, JSON.parse(result.stdout))
      }
      return result
    }
    if (args[0] === 'api') {
      const target = [...metadata].find(
        ([identity]) => args[1] === `repos/${identity.replace(':', '/pulls/')}`
      )
      if (target) {
        const [, item] = target
        return {
          stdout: JSON.stringify({
            number: item.number,
            title: item.title,
            state: String(item.state).toLowerCase(),
            html_url: item.url,
            updated_at: item.updatedAt,
            draft: item.isDraft,
            head: { ref: item.headRefName, sha: item.headRefOid },
            base: { ref: item.baseRefName, sha: item.baseRefOid }
          })
        }
      }
    }
    if (
      args[1] === 'graphql' &&
      args.some((arg) => arg.startsWith('query=') && arg.includes('statusCheckRollup'))
    ) {
      const field = (name: string) =>
        args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1)
      const item = metadata.get(`${field('owner')}/${field('repo')}:${field('number')}`)
      if (item) {
        if (unavailableChecks) {
          throw new Error('checks unavailable')
        }
        return completePRCheckGraphQLResponse(
          Number(item.number),
          String(item.headRefOid),
          contexts
        )
      }
    }
    if (
      unavailableChecks &&
      args[0] === 'api' &&
      [...metadata].some(
        ([target, item]) =>
          args[1] ===
          `repos/${target.split(':')[0]}/commits/${String(item.headRefOid)}/check-runs?per_page=100&page=1`
      )
    ) {
      throw new Error('checks recovery unavailable')
    }
    unexpectedRequests.push(args)
    throw new Error('unexpected gh request')
  })
}

/** Keep metadata/mutation scripts independent of head-pinned check collection. */
export function installIndependentCheckFixtures(
  mocks: GitHubClientMocks,
  metadataRequests: Mock,
  unexpectedChecks: string[][]
): void {
  const targets = new Map<
    string,
    { number: number; head: string; contexts: Record<string, unknown>[] }
  >()
  metadataRequests.mockReset()
  unexpectedChecks.length = 0
  mocks.ghExecFileAsyncMock.mockImplementation(async (args: string[], ...options: unknown[]) => {
    const field = (name: string) =>
      args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1)
    if (
      args[1] === 'graphql' &&
      args.some(
        (arg) =>
          arg.startsWith('query=') &&
          arg.includes('statusCheckRollup') &&
          !arg.includes('updatedAt')
      )
    ) {
      const target = targets.get(`${field('owner')}/${field('repo')}:${field('number')}`)
      if (target) {
        return completePRCheckGraphQLResponse(target.number, target.head, target.contexts)
      }
      unexpectedChecks.push(args)
      throw new Error('checks requested for an unregistered metadata target')
    }
    const response = await metadataRequests(args, ...options)
    if (response?.stdout) {
      const exact = args[0] === 'pr' && args[1] === 'view'
      const restRepo =
        args[0] === 'api'
          ? /^repos\/([^/]+\/[^/]+)\/pulls(?:\/\d+|\?head=)/.exec(args[1])?.[1]
          : undefined
      if (exact || restRepo) {
        const parsed = JSON.parse(response.stdout)
        for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
          if (!item || typeof item !== 'object') {
            continue
          }
          const head = exact ? item.headRefOid : item.head?.sha
          const repo =
            restRepo ??
            (args.includes('--repo')
              ? args[args.indexOf('--repo') + 1]
              : /https?:\/\/[^/]+\/([^/]+\/[^/]+)\/pull\//.exec(item.url)?.[1])
          if (repo && typeof item.number === 'number' && typeof head === 'string') {
            targets.set(`${repo}:${item.number}`, {
              number: item.number,
              head,
              contexts: (item.statusCheckRollup ?? []).map((row: Record<string, unknown>) => ({
                __typename: row.__typename ?? (row.context ? 'StatusContext' : 'CheckRun'),
                ...(!row.context ? { checkSuite: { databaseId: 1 } } : {}),
                ...row
              }))
            })
          }
        }
      }
    }
    return response
  })
}
