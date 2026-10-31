import { beforeEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  PrForBranch,
  OptionalPRRefreshReason
} from '../../shared/rpc-contract/github-pull-request-params'
import { RepoSelector } from '../../shared/rpc-contract/github-repo-target-params'
import { requiredString } from '../../shared/rpc-contract/rpc-param-primitives'
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

// Exact PR request schema at 233b3dc70474180c852ffbb7081da511fcc54f01, before optional intent.
const oldParams = RepoSelector.extend({
  branch: requiredString('Missing branch'),
  reason: OptionalPRRefreshReason,
  linkedPRNumber: z.number().int().positive().nullable().optional(),
  fallbackPRNumber: z.number().int().positive().nullable().optional(),
  acceptMergedFallbackPR: z.boolean().optional(),
  currentHeadOid: z.string().nullable().optional()
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
  // SAFETY: this handler only reads runtime.getRepoPRForBranch; unrelated runtime services are not exercised.
  await method.handler(params, { runtime: commands } as never)
  expect(lookup).toHaveBeenCalledWith('/repo', 'main', null, null, null, {
    localGitExecOptions: { admissionTier: 'interactive' },
    userRefresh: true
  })
})

it('an old host strips the optional field on the same operation and preserves its old routing', async () => {
  const method = GITHUB_PULL_REQUEST_METHODS[0]
  expect(method.name).toBe('github.prForBranch')
  const params = oldParams.parse({
    repo: repo.id,
    branch: 'main',
    reason: 'manual',
    userRefresh: true
  })
  expect(params).not.toHaveProperty('userRefresh')
  await commands.getRepoPRForBranch(
    params.repo,
    params.branch,
    params.linkedPRNumber,
    params.fallbackPRNumber,
    params.acceptMergedFallbackPR,
    params.currentHeadOid,
    params.reason
  )
  expect(lookup).toHaveBeenCalledWith('/repo', 'main', null, null, null, {
    localGitExecOptions: { admissionTier: 'interactive' }
  })
  lookup.mockClear()
  await commands.getRepoPRForBranch(repo.id, 'main')
  expect(lookup).toHaveBeenCalledWith('/repo', 'main', null, null, null)
})
