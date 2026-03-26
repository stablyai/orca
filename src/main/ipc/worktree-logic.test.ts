import { join } from 'path'
import { describe, expect, it } from 'vitest'
import {
  sanitizeWorktreeName,
  ensurePathWithinWorkspace,
  computeBranchName,
  computeWorktreePath,
  shouldSetDisplayName,
  mergeWorktree,
  parseWorktreeId,
  formatWorktreeRemovalError,
  isOrphanedWorktreeError
} from './worktree-logic'

describe('sanitizeWorktreeName', () => {
  it('replaces spaces with hyphens', () => {
    expect(sanitizeWorktreeName('my feature')).toBe('my-feature')
  })

  it('collapses multiple spaces to a single hyphen', () => {
    expect(sanitizeWorktreeName('my   big   feature')).toBe('my-big-feature')
  })

  it('trims leading and trailing whitespace', () => {
    expect(sanitizeWorktreeName('  padded name  ')).toBe('padded-name')
  })

  it('returns the name unchanged when there are no spaces', () => {
    expect(sanitizeWorktreeName('no-spaces')).toBe('no-spaces')
  })

  it('strips unsafe characters', () => {
    expect(sanitizeWorktreeName('feat@#$ure')).toBe('feat-ure')
  })

  it('collapses consecutive hyphens', () => {
    expect(sanitizeWorktreeName('a---b')).toBe('a-b')
  })

  it('strips leading/trailing dots and hyphens', () => {
    expect(sanitizeWorktreeName('.hidden-')).toBe('hidden')
  })

  it('throws for empty name', () => {
    expect(() => sanitizeWorktreeName('')).toThrow('Invalid worktree name')
  })

  it('throws for whitespace-only name', () => {
    expect(() => sanitizeWorktreeName('   ')).toThrow('Invalid worktree name')
  })
})

describe('ensurePathWithinWorkspace', () => {
  it('returns resolved path when within workspace', () => {
    const result = ensurePathWithinWorkspace('/workspace/feature', '/workspace')
    expect(result).toBe('/workspace/feature')
  })

  it('throws when path traverses outside workspace', () => {
    expect(() => ensurePathWithinWorkspace('/workspace/../outside', '/workspace')).toThrow(
      'Invalid worktree path'
    )
  })
})

describe('computeBranchName', () => {
  it('prefixes with git username when branchPrefix is git-username and username is present', () => {
    expect(computeBranchName('feature', { branchPrefix: 'git-username' }, 'jdoe')).toBe(
      'jdoe/feature'
    )
  })

  it('returns bare name when branchPrefix is git-username but username is null', () => {
    expect(computeBranchName('feature', { branchPrefix: 'git-username' }, null)).toBe('feature')
  })

  it('prefixes with custom value when branchPrefix is custom', () => {
    expect(
      computeBranchName('feature', { branchPrefix: 'custom', branchPrefixCustom: 'team' }, null)
    ).toBe('team/feature')
  })

  it('returns bare name when branchPrefix is custom but custom value is empty', () => {
    expect(
      computeBranchName('feature', { branchPrefix: 'custom', branchPrefixCustom: '' }, null)
    ).toBe('feature')
  })

  it('returns bare name when branchPrefix is none', () => {
    expect(computeBranchName('feature', { branchPrefix: 'none' }, 'jdoe')).toBe('feature')
  })
})

describe('computeWorktreePath', () => {
  it('nests under repo name when nestWorkspaces is true', () => {
    expect(
      computeWorktreePath('feature', '/repos/my-project', {
        nestWorkspaces: true,
        workspaceDir: '/workspaces'
      })
    ).toBe(join('/workspaces', 'my-project', 'feature'))
  })

  it('uses flat layout when nestWorkspaces is false', () => {
    expect(
      computeWorktreePath('feature', '/repos/my-project', {
        nestWorkspaces: false,
        workspaceDir: '/workspaces'
      })
    ).toBe(join('/workspaces', 'feature'))
  })

  it('strips .git suffix from repo path when nesting', () => {
    expect(
      computeWorktreePath('feature', '/repos/my-project.git', {
        nestWorkspaces: true,
        workspaceDir: '/workspaces'
      })
    ).toBe(join('/workspaces', 'my-project', 'feature'))
  })
})

describe('shouldSetDisplayName', () => {
  it('returns false when requestedName matches both branchName and sanitizedName', () => {
    expect(shouldSetDisplayName('feature', 'feature', 'feature')).toBe(false)
  })

  it('returns true when requestedName differs from sanitizedName (had spaces)', () => {
    expect(shouldSetDisplayName('my feature', 'my-feature', 'my-feature')).toBe(true)
  })

  it('returns true when branchName differs due to prefix', () => {
    expect(shouldSetDisplayName('feature', 'jdoe/feature', 'feature')).toBe(true)
  })
})

describe('mergeWorktree', () => {
  const baseGit = {
    path: '/workspaces/feature',
    head: 'abc123',
    branch: 'refs/heads/feature-x',
    isBare: false
  }

  it('merges with full metadata', () => {
    const meta = {
      displayName: 'My Feature',
      comment: 'WIP',
      linkedIssue: 42,
      linkedPR: 10,
      isArchived: true,
      isUnread: true,
      sortOrder: 5
    }
    const result = mergeWorktree('repo1', baseGit, meta)
    expect(result).toEqual({
      id: 'repo1::/workspaces/feature',
      repoId: 'repo1',
      path: '/workspaces/feature',
      head: 'abc123',
      branch: 'refs/heads/feature-x',
      isBare: false,
      displayName: 'My Feature',
      comment: 'WIP',
      linkedIssue: 42,
      linkedPR: 10,
      isArchived: true,
      isUnread: true,
      sortOrder: 5
    })
  })

  it('uses defaults when metadata is undefined', () => {
    const result = mergeWorktree('repo1', baseGit, undefined)
    expect(result.displayName).toBe('feature-x')
    expect(result.comment).toBe('')
    expect(result.linkedIssue).toBeNull()
    expect(result.linkedPR).toBeNull()
    expect(result.isArchived).toBe(false)
    expect(result.isUnread).toBe(false)
    expect(result.sortOrder).toBe(0)
  })

  it('strips refs/heads/ prefix from branch for display name', () => {
    const result = mergeWorktree('repo1', baseGit, undefined)
    expect(result.displayName).toBe('feature-x')
  })

  it('falls back to basename when bare worktree has no branch', () => {
    const bareGit = {
      path: '/workspaces/bare-repo',
      head: '000000',
      branch: '',
      isBare: true
    }
    const result = mergeWorktree('repo1', bareGit, undefined)
    expect(result.displayName).toBe('bare-repo')
  })
})

describe('parseWorktreeId', () => {
  it('parses valid "repoId::path" format', () => {
    expect(parseWorktreeId('repo1::/workspaces/feature')).toEqual({
      repoId: 'repo1',
      worktreePath: '/workspaces/feature'
    })
  })

  it('handles paths containing colons', () => {
    expect(parseWorktreeId('repo1::C:/Users/test')).toEqual({
      repoId: 'repo1',
      worktreePath: 'C:/Users/test'
    })
  })

  it('throws on invalid format without ::', () => {
    expect(() => parseWorktreeId('invalid-id')).toThrow('Invalid worktreeId: invalid-id')
  })
})

describe('formatWorktreeRemovalError', () => {
  const path = '/workspaces/feature'

  it('returns fallback for non-Error input', () => {
    expect(formatWorktreeRemovalError('oops', path, false)).toBe(
      `Failed to delete worktree at ${path}.`
    )
  })

  it('includes stderr when present on Error', () => {
    const error = Object.assign(new Error('generic'), { stderr: 'branch not clean' })
    expect(formatWorktreeRemovalError(error, path, false)).toBe(
      `Failed to delete worktree at ${path}. branch not clean`
    )
  })

  it('falls back to message when no stderr/stdout', () => {
    const error = new Error('something went wrong')
    expect(formatWorktreeRemovalError(error, path, false)).toBe(
      `Failed to delete worktree at ${path}. something went wrong`
    )
  })

  it('uses force text when force is true', () => {
    expect(formatWorktreeRemovalError('oops', path, true)).toBe(
      `Failed to force delete worktree at ${path}.`
    )
  })

  it('returns fallback when Error has empty message and no streams', () => {
    const error = new Error(' ')
    error.message = ''
    expect(formatWorktreeRemovalError(error, path, false)).toBe(
      `Failed to delete worktree at ${path}.`
    )
  })
})

describe('isOrphanedWorktreeError', () => {
  it('returns true when stderr contains "is not a working tree"', () => {
    const error = Object.assign(new Error('git failed'), {
      stderr: "fatal: '/some/path' is not a working tree"
    })
    expect(isOrphanedWorktreeError(error)).toBe(true)
  })

  it('returns true when message contains "is not a working tree"', () => {
    const error = new Error("fatal: '/some/path' is not a working tree")
    expect(isOrphanedWorktreeError(error)).toBe(true)
  })

  it('returns false for unrelated git errors', () => {
    const error = Object.assign(new Error('git failed'), {
      stderr: 'fatal: contains modified or untracked files'
    })
    expect(isOrphanedWorktreeError(error)).toBe(false)
  })

  it('returns false for non-Error input', () => {
    expect(isOrphanedWorktreeError('string error')).toBe(false)
    expect(isOrphanedWorktreeError(null)).toBe(false)
  })
})
