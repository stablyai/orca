import { describe, expect, it } from 'vitest'
import {
  buildWorktreeFolderNameTokens,
  expandWorktreeFolderName,
  type WorktreeFolderNameTokens
} from './worktree-folder-name-template'

const BASE_TOKENS: WorktreeFolderNameTokens = {
  projectName: 'my-project',
  workspaceName: 'feature',
  gitBranchName: 'alice/fix-login',
  gitBranchSlug: 'alice-fix-login',
  branchPrefix: 'alice',
  gitUsername: 'alice',
  date: '2026-06-29',
  shortId: 'deadbeef'
}

describe('expandWorktreeFolderName', () => {
  it('expands every supported token and the repoName alias', () => {
    expect(
      expandWorktreeFolderName(
        [
          '%projectName%',
          '%repoName%',
          '%workspaceName%',
          '%gitBranchName%',
          '%gitBranchSlug%',
          '%branchPrefix%',
          '%gitUsername%',
          '%date%',
          '%shortId%'
        ].join('_'),
        BASE_TOKENS
      )
    ).toBe(
      'my-project_my-project_feature_alice-fix-login_alice-fix-login_alice_alice_2026-06-29_deadbeef'
    )
  })

  it('strips unknown and typoed tokens before sanitizing the remaining text', () => {
    expect(expandWorktreeFolderName('%projectname%_%workspaceName%', BASE_TOKENS)).toBe('_feature')
  })

  it('collapses slashes to a single folder segment', () => {
    expect(expandWorktreeFolderName('team/%workspaceName%', BASE_TOKENS)).toBe('team-feature')
  })

  it('returns null for empty and whitespace-only templates', () => {
    expect(expandWorktreeFolderName('', BASE_TOKENS)).toBeNull()
    expect(expandWorktreeFolderName('   ', BASE_TOKENS)).toBeNull()
    expect(expandWorktreeFolderName(undefined, BASE_TOKENS)).toBeNull()
  })

  it('returns null when expansion sanitizes to empty', () => {
    expect(
      expandWorktreeFolderName('%gitUsername%', { ...BASE_TOKENS, gitUsername: '' })
    ).toBeNull()
  })

  it('sanitizes traversal-looking template output safely', () => {
    expect(expandWorktreeFolderName('..%workspaceName%', BASE_TOKENS)).toBe('feature')
  })

  it('produces identical leaves for branch name and branch slug after sanitization', () => {
    expect(expandWorktreeFolderName('%gitBranchName%', BASE_TOKENS)).toBe('alice-fix-login')
    expect(expandWorktreeFolderName('%gitBranchSlug%', BASE_TOKENS)).toBe('alice-fix-login')
  })
})

describe('buildWorktreeFolderNameTokens', () => {
  it('derives token values from repo, branch, settings, username, date, and short id', () => {
    const now = new Date(2026, 5, 29, 9, 30, 0).getTime()

    expect(
      buildWorktreeFolderNameTokens({
        repoPath: '/repos/my-project.git',
        sanitizedName: 'feature',
        branchName: 'alice/fix-login',
        settings: { branchPrefix: 'git-username', branchPrefixCustom: '' },
        username: 'alice',
        now,
        shortId: 'deadbeef'
      })
    ).toEqual({
      projectName: 'my-project',
      workspaceName: 'feature',
      gitBranchName: 'alice/fix-login',
      gitBranchSlug: 'alice-fix-login',
      branchPrefix: 'alice',
      gitUsername: 'alice',
      date: '2026-06-29',
      shortId: 'deadbeef'
    })
  })

  it('uses an override branch verbatim instead of recomputing from the workspace name', () => {
    const tokens = buildWorktreeFolderNameTokens({
      repoPath: 'C:\\repos\\my-project.git',
      sanitizedName: 'feature',
      branchName: 'alice/fix-login',
      settings: { branchPrefix: 'custom', branchPrefixCustom: 'team' },
      username: null,
      now: new Date(2026, 5, 29).getTime(),
      shortId: 'cafebabe'
    })

    expect(tokens.projectName).toBe('my-project')
    expect(tokens.gitBranchName).toBe('alice/fix-login')
    expect(tokens.gitBranchSlug).toBe('alice-fix-login')
    expect(tokens.branchPrefix).toBe('team')
    expect(tokens.gitUsername).toBe('')
    expect(tokens.shortId).toBe('cafebabe')
  })
})
