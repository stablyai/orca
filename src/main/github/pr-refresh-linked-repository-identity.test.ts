import { describe, expect, it } from 'vitest'
import type { GitHubPRRefreshCandidate } from '../../shared/github/pull-request-refresh-types'
import {
  aliasFromCandidate,
  hostedReviewOptionArgs,
  refreshKey,
  sameAliasRequestIdentity
} from './pr-refresh-candidate-policy'
import { hostedReviewBranchCacheKey } from '../source-control/hosted-review-branch-cache'

const FRONTEND = { owner: 'relayto', repo: 'relayto-frontend' }
const API = { owner: 'relayto', repo: 'relayto-api' }

const candidate = (
  overrides: Partial<GitHubPRRefreshCandidate> = {}
): GitHubPRRefreshCandidate => ({
  cacheKey: 'repo::main',
  repoId: 'repo',
  repoPath: '/docker',
  repoKind: 'git',
  branch: 'main',
  linkedPRNumber: 2383,
  ...overrides
})

describe('linked PR repository in refresh identities', () => {
  it('keeps same-repo refresh keys unchanged and splits other repositories', () => {
    expect(refreshKey(candidate())).toBe('local::runtime:host::/docker::pr::2383')
    expect(refreshKey(candidate({ linkedPRRepository: FRONTEND }))).not.toBe(
      refreshKey(candidate({ linkedPRRepository: API }))
    )
    expect(refreshKey(candidate({ linkedPRRepository: FRONTEND }))).toBe(
      refreshKey(candidate({ linkedPRRepository: { owner: 'Relayto', repo: 'Relayto-Frontend' } }))
    )
  })

  it('carries the repository on aliases and compares it as request identity', () => {
    const alias = aliasFromCandidate(candidate({ linkedPRRepository: FRONTEND }))
    expect(alias.linkedPRRepository).toEqual(FRONTEND)
    expect(sameAliasRequestIdentity(alias, { ...alias, linkedPRRepository: API })).toBe(false)
    expect(aliasFromCandidate(candidate())).not.toHaveProperty('linkedPRRepository')
  })

  it('hands the repository to the lookup only for an exact linked number', () => {
    expect(hostedReviewOptionArgs(candidate({ linkedPRRepository: FRONTEND }))[0]).toMatchObject({
      linkedPRRepository: FRONTEND
    })
    expect(
      hostedReviewOptionArgs(
        candidate({ linkedPRNumber: null, fallbackPRNumber: 5, linkedPRRepository: FRONTEND })
      )[0]
    ).not.toHaveProperty('linkedPRRepository')
  })

  it('keys the host branch-review cache by the linked repository', () => {
    const identity = {
      repoPath: '/docker',
      executionHostId: 'local' as const,
      branch: 'main',
      linkedGitHubPR: 2383
    }
    expect(
      hostedReviewBranchCacheKey({ ...identity, linkedGitHubPRRepository: FRONTEND })
    ).not.toBe(hostedReviewBranchCacheKey({ ...identity, linkedGitHubPRRepository: API }))
    expect(hostedReviewBranchCacheKey({ ...identity, linkedGitHubPRRepository: null })).toBe(
      hostedReviewBranchCacheKey(identity)
    )
  })
})
