import { beforeEach, expect, it, vi } from 'vitest'
import {
  PrForBranch,
  PullRequestChecks
} from '../../shared/rpc-contract/github-pull-request-params'
import { OrcaRuntimeService } from './orca-runtime'
import { RuntimeHostedReviewCommands } from './runtime-hosted-review-commands'
import { GITHUB_PULL_REQUEST_METHODS } from './rpc/methods/github-pull-request-methods'

const lookup = vi.hoisted(() => vi.fn())
vi.mock('../github/client', () => ({
  getPRForBranchOutcome: lookup,
  createGitHubPullRequest: vi.fn()
}))

const repo = { id: 'repo-1', path: '/repo', displayName: 'repo', badgeColor: '#000', addedAt: 0 }
const commands = new RuntimeHostedReviewCommands({
  resolveRepo: async () => repo,
  resolveTarget: async () => ({ repo, repoPath: repo.path }),
  getExecutionOptions: (_repo, admissionTier) =>
    admissionTier ? { localGitExecOptions: { admissionTier } } : undefined,
  recordCreated: vi.fn()
})

beforeEach(() => {
  lookup.mockReset()
  lookup.mockResolvedValue({ kind: 'no-pr', fetchedAt: 1 })
})

it('forwards parsed intent through the existing RPC method and runtime command', async () => {
  const method = GITHUB_PULL_REQUEST_METHODS.find((entry) => entry.name === 'github.prForBranch')
  if (!method) {
    throw new Error('missing existing PR operation')
  }
  const params = PrForBranch.parse({
    repo: repo.id,
    branch: 'main',
    reason: 'manual',
    userRefresh: true
  })
  // The real hosted-review command behind the runtime surface this handler reads.
  const runtime = new OrcaRuntimeService()
  vi.spyOn(runtime, 'getRepoPRForBranch').mockImplementation((...args) =>
    commands.getRepoPRForBranch(...args)
  )
  await method.handler(params, { runtime })
  expect(lookup).toHaveBeenCalledWith('/repo', 'main', null, null, null, {
    localGitExecOptions: { admissionTier: 'interactive' },
    userRefresh: true
  })
})

it('forwards parsed checks intent through the existing RPC method', async () => {
  const method = GITHUB_PULL_REQUEST_METHODS.find((entry) => entry.name === 'github.prChecks')
  if (!method) {
    throw new Error('missing existing checks operation')
  }
  const params = PullRequestChecks.parse({
    repo: repo.id,
    prNumber: 12,
    headSha: 'head-a',
    noCache: true,
    userRefresh: true
  })
  const runtime = new OrcaRuntimeService()
  const getRepoPRChecks = vi.spyOn(runtime, 'getRepoPRChecks').mockResolvedValue([])
  await method.handler(params, { runtime })
  expect(getRepoPRChecks).toHaveBeenCalledWith(repo.id, 12, 'head-a', null, {
    noCache: true,
    userRefresh: true
  })
})
