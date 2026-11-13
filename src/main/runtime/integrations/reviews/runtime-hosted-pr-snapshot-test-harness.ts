import { afterEach, beforeEach, vi } from 'vitest'
import { makePR } from '../../../github/pull-requests/refresh/pr-refresh-coordinator-test-harness'
import type { PRRefreshOutcome } from '../../../../shared/github/pull-requests/refresh/pull-request-refresh-types'
import type { RuntimeHostedReviewCommands } from './runtime-hosted-review-commands'

export const mocks = vi.hoisted(() => ({ resolve: vi.fn(), account: vi.fn(), gate: vi.fn() }))
vi.mock('../../../github/accounts/github-project-account', () => ({
  githubPRPolicyProjects: () => ({ source: null, selection: String(mocks.account()) }),
  resolveGitHubProjectAccount: mocks.account
}))
vi.mock('../../../github/execution/github-operation-slots', () => ({
  acquire: async () => {},
  release: () => {}
}))
vi.mock('../../../github/client/lookup/branch-lookup-resolution', () => ({
  resolvePRForBranchOutcome: mocks.resolve
}))
vi.mock('../../../github/pull-requests/refresh/pr-refresh-rate-limit-gate', () => ({
  prRefreshRateLimitPausedUntil: mocks.gate
}))

export let commands: RuntimeHostedReviewCommands
export const fixture = { title: 'before' }
export const found = (): PRRefreshOutcome => ({
  kind: 'found',
  fetchedAt: Date.now(),
  pr: makePR({
    title: fixture.title,
    headSha: 'head-a',
    checksStatus: 'success',
    checksReadComplete: true,
    checksFinal: true,
    autoMergeEnabled: false,
    mergeQueueRequired: false
  })
})
export const read = (
  branch: string,
  reason: 'active' | 'visible' | 'swr' | 'manual' = 'swr',
  head = 'head-a'
) =>
  commands.getRepoPRForBranch(
    'repo',
    branch,
    null,
    null,
    false,
    head,
    reason,
    undefined,
    undefined,
    undefined,
    true
  )

beforeEach(async () => {
  vi.resetModules()
  vi.useFakeTimers()
  vi.setSystemTime(1_000)
  fixture.title = 'before'
  mocks.resolve.mockReset().mockImplementation(async () => found())
  mocks.account.mockReset().mockReturnValue(null)
  mocks.gate.mockReset().mockResolvedValue(null)
  const { RuntimeHostedReviewCommands: Commands } = await import('./runtime-hosted-review-commands')
  const repo = {
    id: 'repo',
    path: '/repo',
    kind: 'git' as const,
    displayName: 'repo',
    badgeColor: 'blue',
    addedAt: 0
  }
  commands = new Commands({
    resolveRepo: async () => repo,
    resolveTarget: async () => ({ repo, repoPath: repo.path }),
    getExecutionOptions: () => undefined,
    recordCreated: () => {}
  })
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})
