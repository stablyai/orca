/* eslint-disable max-lines -- Why: these worktree path/name tests share a
single setup-free pure-logic module, and splitting them would make the related
edge cases harder to audit together. */
import { posix, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  sanitizeWorktreeName,
  sanitizeWorktreeDisplayName,
  ensurePathWithinWorkspace,
  computeBranchName,
  getConfiguredBranchPrefix,
  computeWorktreePath,
  computeRemoteWorktreePath,
  computeWorkspaceRoot,
  getWorktreeCreationLayout,
  getWorktreePathSettings,
  shouldSetDisplayName,
  mergeWorktree,
  parseWorktreeId,
  formatWorktreeRemovalError,
  isWindowsLongPathWorktreeRemovalError,
  isOrphanCompatiblePreflightError,
  isOrphanedWorktreeError,
  areWorktreePathsEqual
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

  it('collapses internal consecutive dots so git check-ref-format accepts the branch', () => {
    // Why: a prompt containing `../../` used to slugify to `..-..-foo` and
    // survive sanitization with `..` intact. `git branch` then rejected it
    // with "is not a valid branch name", breaking worktree creation from the
    // composer's auto-named branches.
    expect(sanitizeWorktreeName('for-..-..-feature')).toBe('for-.-.-feature')
    expect(sanitizeWorktreeName('a..b...c')).toBe('a.b.c')
  })

  it('preserves non-ASCII letters and numbers', () => {
    // Why: users name workspaces in their own language (CJK, accented Latin,
    // Cyrillic, etc.). Stripping these to ASCII left the name empty and threw
    // "Invalid worktree name" on every non-Latin keyboard input.
    expect(sanitizeWorktreeName('中文')).toBe('中文')
    expect(sanitizeWorktreeName('日本語 テスト')).toBe('日本語-テスト')
    expect(sanitizeWorktreeName('café-déjà')).toBe('café-déjà')
    expect(sanitizeWorktreeName('Привет мир')).toBe('Привет-мир')
  })

  it('still strips git-unsafe punctuation around Unicode names', () => {
    expect(sanitizeWorktreeName('feat: 中文 (v2)')).toBe('feat-中文-v2')
  })

  it('throws for empty name', () => {
    expect(() => sanitizeWorktreeName('')).toThrow('Invalid worktree name')
  })

  it('throws for whitespace-only name', () => {
    expect(() => sanitizeWorktreeName('   ')).toThrow('Invalid worktree name')
  })
})

describe('sanitizeWorktreeDisplayName', () => {
  it('keeps readable punctuation while collapsing unsafe controls and whitespace', () => {
    expect(sanitizeWorktreeDisplayName('  Fix: login / callback\n\tregression\u0000  ')).toBe(
      'Fix: login / callback regression'
    )
  })

  it('strips bidi override controls from external artifact titles', () => {
    expect(sanitizeWorktreeDisplayName('Review \u202eexe.txt')).toBe('Review exe.txt')
  })

  it('truncates very long titles', () => {
    const title = 'a'.repeat(200)
    expect(sanitizeWorktreeDisplayName(title)).toHaveLength(120)
  })

  it('returns undefined when nothing displayable remains', () => {
    expect(sanitizeWorktreeDisplayName('\u0000\n\t')).toBeUndefined()
  })
})

describe('ensurePathWithinWorkspace', () => {
  it('returns resolved path when within workspace', () => {
    const result = ensurePathWithinWorkspace('/workspace/feature', '/workspace')
    expect(result).toBe(resolve('/workspace/feature'))
  })

  it('throws when path traverses outside workspace', () => {
    expect(() => ensurePathWithinWorkspace('/workspace/../outside', '/workspace')).toThrow(
      'Invalid worktree path'
    )
  })

  it('allows workspace children whose names start with dot-dot text', () => {
    const result = ensurePathWithinWorkspace('/workspace/..repo/feature', '/workspace')

    expect(result).toBe(resolve('/workspace/..repo/feature'))
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

describe('getConfiguredBranchPrefix', () => {
  it('returns the git username for the git-username strategy', () => {
    expect(getConfiguredBranchPrefix({ branchPrefix: 'git-username' }, 'jdoe')).toBe('jdoe')
  })

  it('returns null for git-username when no username is available', () => {
    expect(getConfiguredBranchPrefix({ branchPrefix: 'git-username' }, null)).toBeNull()
  })

  it('returns the custom value for the custom strategy', () => {
    expect(
      getConfiguredBranchPrefix({ branchPrefix: 'custom', branchPrefixCustom: 'team' }, null)
    ).toBe('team')
  })

  it('returns null for custom strategy with an empty value', () => {
    expect(
      getConfiguredBranchPrefix({ branchPrefix: 'custom', branchPrefixCustom: '' }, null)
    ).toBeNull()
  })

  it('returns null when no prefix strategy applies', () => {
    expect(getConfiguredBranchPrefix({ branchPrefix: 'none' }, 'jdoe')).toBeNull()
  })
})

describe('computeWorktreePath', () => {
  it('nests under repo name when nestWorkspaces is true', () => {
    expect(
      computeWorktreePath('feature', '/repos/my-project', {
        nestWorkspaces: true,
        workspaceDir: '/workspaces'
      })
    ).toBe(posix.join('/workspaces', 'my-project', 'feature'))
  })

  it('uses flat layout when nestWorkspaces is false', () => {
    expect(
      computeWorktreePath('feature', '/repos/my-project', {
        nestWorkspaces: false,
        workspaceDir: '/workspaces'
      })
    ).toBe(posix.join('/workspaces', 'feature'))
  })

  it('strips .git suffix from repo path when nesting', () => {
    expect(
      computeWorktreePath('feature', '/repos/my-project.git', {
        nestWorkspaces: true,
        workspaceDir: '/workspaces'
      })
    ).toBe(posix.join('/workspaces', 'my-project', 'feature'))
  })

  it('resolves relative workspace directories from the repo path', () => {
    expect(computeWorkspaceRoot('/projects/app/repo', { workspaceDir: '../worktrees' })).toBe(
      posix.resolve('/projects/app/worktrees')
    )
    expect(
      computeWorktreePath('feature', '/projects/app/repo', {
        nestWorkspaces: false,
        workspaceDir: '../worktrees'
      })
    ).toBe(posix.resolve('/projects/app/worktrees/feature'))
  })

  it('scopes the same relative repo override to each repo root', () => {
    const settings = { nestWorkspaces: false, workspaceDir: '/global/workspaces' }
    const repoA = { path: '/projects/a/repo', worktreeBasePath: '../worktrees' }
    const repoB = { path: '/projects/b/repo', worktreeBasePath: '../worktrees' }

    expect(
      computeWorktreePath('feature', repoA.path, getWorktreePathSettings(repoA, settings))
    ).toBe(posix.resolve('/projects/a/worktrees/feature'))
    expect(
      computeWorktreePath('feature', repoB.path, getWorktreePathSettings(repoB, settings))
    ).toBe(posix.resolve('/projects/b/worktrees/feature'))
    expect(getWorktreeCreationLayout(repoA, settings)).toEqual({
      path: '../worktrees',
      nestWorkspaces: false
    })
  })

  it('resolves Windows-style relative workspace directories with Windows separators', () => {
    expect(
      computeWorktreePath('feature', 'C:\\Projects\\app\\repo', {
        nestWorkspaces: false,
        workspaceDir: '..\\worktrees'
      })
    ).toBe('C:\\Projects\\app\\worktrees\\feature')
  })

  it('keeps legacy SSH sibling paths for global absolute workspace directories', () => {
    expect(
      computeRemoteWorktreePath('feature', '/remote/repo', {
        nestWorkspaces: false,
        workspaceDir: '/local/workspaces'
      })
    ).toBe('/remote/feature')
  })

  it('applies repo-specific SSH workspace directories on the remote path', () => {
    expect(
      computeRemoteWorktreePath(
        'feature',
        '/remote/project/repo',
        {
          nestWorkspaces: false,
          workspaceDir: '../worktrees'
        },
        { useConfiguredAbsolutePath: true }
      )
    ).toBe('/remote/project/worktrees/feature')
    expect(
      computeRemoteWorktreePath(
        'feature',
        'C:\\Remote\\repo',
        {
          nestWorkspaces: false,
          workspaceDir: '..\\worktrees'
        },
        { useConfiguredAbsolutePath: true }
      )
    ).toBe('C:\\Remote\\worktrees\\feature')
  })
})

describe('areWorktreePathsEqual', () => {
  it('treats Windows slash and casing differences as the same path', () => {
    expect(
      areWorktreePathsEqual(
        'C:\\Workspaces\\Improve-Dashboard',
        'c:/workspaces/improve-dashboard',
        'win32'
      )
    ).toBe(true)
  })

  it('keeps POSIX path comparison case-sensitive', () => {
    expect(areWorktreePathsEqual('/tmp/Worktree', '/tmp/worktree', 'linux')).toBe(false)
  })

  it('keeps WSL-owned POSIX paths case-sensitive on Windows', () => {
    expect(areWorktreePathsEqual('/home/dev/Repo', '/home/dev/repo', 'win32')).toBe(false)
  })

  it('does not collapse WSL POSIX paths with Windows drive paths', () => {
    expect(areWorktreePathsEqual('/home/dev/repo', 'C:\\home\\dev\\repo', 'win32')).toBe(false)
  })

  it('treats macOS /private/tmp git paths as matching /tmp workspace paths', () => {
    expect(
      areWorktreePathsEqual(
        '/private/tmp/orca-proof/worktrees/repo/feature',
        '/tmp/orca-proof/worktrees/repo/feature',
        'darwin'
      )
    ).toBe(true)
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
    isBare: false,
    isMainWorktree: false
  }

  it('merges with full metadata', () => {
    const meta = {
      displayName: 'My Feature',
      comment: 'WIP',
      linkedIssue: 42,
      linkedPR: 10,
      linkedLinearIssue: null,
      projectId: 'github:stablyai/orca',
      hostId: 'ssh:openclaw-2' as const,
      projectHostSetupId: 'remote-repo',
      linkedGitLabMR: null,
      linkedGitLabIssue: null,
      isArchived: true,
      isUnread: true,
      isPinned: true,
      sortOrder: 5,
      lastActivityAt: 1000,
      workspaceStatus: 'in-review',
      diffComments: [],
      priorWorktreeIds: ['repo1::/workspaces/old-feature'],
      automationProvenance: {
        kind: 'created-by-automation' as const,
        automationId: 'automation-1',
        automationNameSnapshot: 'Nightly review',
        automationRunId: 'run-1',
        automationRunTitleSnapshot: 'Nightly review run',
        createdAt: 123,
        executionTargetType: 'ssh' as const,
        executionTargetId: 'openclaw-2',
        projectId: 'github:stablyai/orca',
        repoId: 'repo1',
        hostId: 'ssh:openclaw-2' as const
      }
    }
    const result = mergeWorktree('repo1', baseGit, meta)
    expect(result).toEqual({
      id: 'repo1::/workspaces/feature',
      repoId: 'repo1',
      path: '/workspaces/feature',
      head: 'abc123',
      branch: 'refs/heads/feature-x',
      isBare: false,
      isMainWorktree: false,
      displayName: 'My Feature',
      comment: 'WIP',
      linkedIssue: 42,
      linkedPR: 10,
      linkedLinearIssue: null,
      linkedLinearIssueWorkspaceId: null,
      linkedLinearIssueOrganizationUrlKey: null,
      linkedGitLabMR: null,
      linkedGitLabIssue: null,
      linkedBitbucketPR: null,
      linkedAzureDevOpsPR: null,
      linkedGiteaPR: null,
      mobileDiffReview: undefined,
      projectId: 'github:stablyai/orca',
      hostId: 'ssh:openclaw-2',
      projectHostSetupId: 'remote-repo',
      isArchived: true,
      isUnread: true,
      isPinned: true,
      sortOrder: 5,
      lastActivityAt: 1000,
      workspaceStatus: 'in-review',
      diffComments: [],
      priorWorktreeIds: ['repo1::/workspaces/old-feature'],
      automationProvenance: {
        kind: 'created-by-automation',
        automationId: 'automation-1',
        automationNameSnapshot: 'Nightly review',
        automationRunId: 'run-1',
        automationRunTitleSnapshot: 'Nightly review run',
        createdAt: 123,
        executionTargetType: 'ssh',
        executionTargetId: 'openclaw-2',
        projectId: 'github:stablyai/orca',
        repoId: 'repo1',
        hostId: 'ssh:openclaw-2'
      }
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
    expect(result.isPinned).toBe(false)
    expect(result.sortOrder).toBe(0)
    expect(result.lastActivityAt).toBe(0)
    expect(result.workspaceStatus).toBe('in-progress')
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
      isBare: true,
      isMainWorktree: false
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

describe('isWindowsLongPathWorktreeRemovalError', () => {
  it('matches Git for Windows long-path deletion failures on Windows', () => {
    const error = Object.assign(new Error('git worktree remove failed'), {
      stderr: 'error: failed to delete some/deep/file: Filename too long'
    })

    expect(isWindowsLongPathWorktreeRemovalError(error, 'win32')).toBe(true)
  })

  it('does not match long-path text off Windows', () => {
    const error = Object.assign(new Error('file name too long'), {
      stderr: 'Filename too long'
    })

    expect(isWindowsLongPathWorktreeRemovalError(error, 'linux')).toBe(false)
  })

  it('does not match unrelated Git removal failures on Windows', () => {
    const error = Object.assign(new Error('git worktree remove failed'), {
      stderr: 'fatal: contains modified or untracked files'
    })

    expect(isWindowsLongPathWorktreeRemovalError(error, 'win32')).toBe(false)
  })
})

describe('isOrphanCompatiblePreflightError', () => {
  it('matches not-a-working-tree errors', () => {
    const error = Object.assign(new Error('git failed'), {
      stderr: "fatal: '/some/path' is not a working tree"
    })

    expect(isOrphanCompatiblePreflightError(error)).toBe(true)
  })

  it('matches status failures from non-repo directories', () => {
    const error = Object.assign(new Error('status failed'), {
      stderr: 'fatal: not a git repository (or any of the parent directories): .git'
    })

    expect(isOrphanCompatiblePreflightError(error)).toBe(true)
  })

  it('matches missing directories by error code', () => {
    const error = Object.assign(new Error('spawn git'), { code: 'ENOENT' })

    expect(isOrphanCompatiblePreflightError(error)).toBe(true)
  })

  it('does not match unrelated subprocess failures', () => {
    const error = Object.assign(new Error('status failed'), {
      stderr: 'fatal: unable to read current working directory'
    })

    expect(isOrphanCompatiblePreflightError(error)).toBe(false)
  })
})
