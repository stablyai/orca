import { describe, expect, it } from 'vitest'
import type { Repo, Worktree } from '../../shared/types'
import {
  buildWorkspaceCleanupCandidate,
  buildWorkspaceCleanupCandidateFromError
} from './workspace-cleanup-candidate'

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo',
    path: '/tmp/repo',
    displayName: 'Repo',
    badgeColor: '#000',
    addedAt: 0,
    ...overrides
  }
}

function makeWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'repo::/tmp/repo/wt',
    repoId: 'repo',
    path: '/tmp/repo/wt',
    branch: 'refs/heads/wt',
    head: 'abc',
    isBare: false,
    isMainWorktree: false,
    displayName: 'Workspace',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...overrides
  }
}

describe('buildWorkspaceCleanupCandidateFromError', () => {
  it('coalesces an undefined displayName to an empty string (crash 99657ab1)', () => {
    // displayName is typed string but arrives undefined for persisted/discovered worktrees.
    const candidate = buildWorkspaceCleanupCandidateFromError(
      makeRepo(),
      makeWorktree({ displayName: undefined as unknown as string }),
      0
    )

    expect(candidate.displayName).toBe('')
  })
})

describe('buildWorkspaceCleanupCandidate', () => {
  // skipGit:true short-circuits git evidence, so no provider shell-out is needed.
  const baseArgs = { scannedAt: 0, provider: null, skipGit: true, forceGitCheck: false }

  it('coalesces an undefined displayName to an empty string without throwing (crash 99657ab1)', async () => {
    const candidate = await buildWorkspaceCleanupCandidate({
      ...baseArgs,
      repo: makeRepo(),
      worktree: makeWorktree({ displayName: undefined as unknown as string })
    })

    expect(candidate.displayName).toBe('')
  })

  it('preserves a defined displayName', async () => {
    const candidate = await buildWorkspaceCleanupCandidate({
      ...baseArgs,
      repo: makeRepo(),
      worktree: makeWorktree({ displayName: 'Beta' })
    })

    expect(candidate.displayName).toBe('Beta')
  })
})
