import { describe, expect, it } from 'vitest'
import {
  formatMobileFolderAwareBranchLabel,
  isMobileFolderWorkspaceId,
  isMobileFolderWorkspaceUnroutedGitMethod,
  mobileFolderWorkspaceGitRpcGuard,
  MOBILE_FOLDER_WORKSPACE_BRANCH_LABEL,
  MOBILE_FOLDER_WORKSPACE_UNSUPPORTED_MESSAGE,
  shouldLoadMobileBranchCompare,
  shouldRetryMobileStatusSelectorNotFound
} from './mobile-folder-workspace-selector'

describe('isMobileFolderWorkspaceId', () => {
  it('detects folder: synthetic worktree ids', () => {
    expect(isMobileFolderWorkspaceId('folder:abc')).toBe(true)
    expect(isMobileFolderWorkspaceId('folder:')).toBe(true)
  })

  it('rejects real worktree ids and other prefixes', () => {
    expect(isMobileFolderWorkspaceId('wt-123')).toBe(false)
    expect(isMobileFolderWorkspaceId('id:folder:abc')).toBe(false)
    expect(isMobileFolderWorkspaceId('')).toBe(false)
    expect(isMobileFolderWorkspaceId('Folder:abc')).toBe(false)
  })
})

describe('shouldRetryMobileStatusSelectorNotFound', () => {
  it('retries for real worktrees (selector may still be registering)', () => {
    expect(shouldRetryMobileStatusSelectorNotFound('wt-123')).toBe(true)
  })

  it('does not retry for folder workspaces (structural, never resolves)', () => {
    expect(shouldRetryMobileStatusSelectorNotFound('folder:group-1')).toBe(false)
  })
})

describe('shouldLoadMobileBranchCompare', () => {
  it('loads branch compare for real worktrees', () => {
    expect(shouldLoadMobileBranchCompare('wt-123')).toBe(true)
  })

  it('skips branch compare for folder workspaces (unrouted RPC)', () => {
    expect(shouldLoadMobileBranchCompare('folder:group-1')).toBe(false)
  })
})

describe('mobileFolderWorkspaceGitRpcGuard', () => {
  it('allows all methods on real worktrees', () => {
    for (const method of [
      'git.status',
      'git.diff',
      'git.branchCompare',
      'git.history',
      'git.fetch',
      'git.pull',
      'git.push',
      'git.upstreamStatus'
    ]) {
      expect(mobileFolderWorkspaceGitRpcGuard('wt-123', method)).toEqual({ allowed: true })
    }
  })

  it('allows routed folder methods (status/diff) and blocks other git.* RPCs', () => {
    expect(mobileFolderWorkspaceGitRpcGuard('folder:g1', 'git.status')).toEqual({
      allowed: true
    })
    expect(mobileFolderWorkspaceGitRpcGuard('folder:g1', 'git.diff')).toEqual({
      allowed: true
    })
    for (const method of [
      'git.branchCompare',
      'git.upstreamStatus',
      'git.fetch',
      'git.pull',
      'git.push',
      'git.history',
      'git.commit',
      'git.stage',
      'git.unknownMethod'
    ]) {
      expect(isMobileFolderWorkspaceUnroutedGitMethod(method)).toBe(true)
      expect(mobileFolderWorkspaceGitRpcGuard('folder:g1', method)).toEqual({
        allowed: false,
        message: MOBILE_FOLDER_WORKSPACE_UNSUPPORTED_MESSAGE
      })
    }
    // Non-git RPCs are not gated by this helper.
    expect(isMobileFolderWorkspaceUnroutedGitMethod('linear.list')).toBe(false)
  })
})

describe('formatMobileFolderAwareBranchLabel', () => {
  it('formats normal branch and head labels', () => {
    expect(formatMobileFolderAwareBranchLabel('wt-1', 'refs/heads/main', 'abc')).toBe('main')
    expect(formatMobileFolderAwareBranchLabel('wt-1', 'feature', undefined)).toBe('feature')
    expect(formatMobileFolderAwareBranchLabel('wt-1', undefined, 'abcdef123')).toBe('abcdef1')
  })

  it('uses No branch for real worktrees without identity', () => {
    expect(formatMobileFolderAwareBranchLabel('wt-1', undefined, undefined)).toBe('No branch')
  })

  it('labels folder workspaces without head/branch instead of blank / No branch', () => {
    expect(formatMobileFolderAwareBranchLabel('folder:g1', undefined, undefined)).toBe(
      MOBILE_FOLDER_WORKSPACE_BRANCH_LABEL
    )
  })

  it('still prefers real branch/head when folder status provides them', () => {
    expect(formatMobileFolderAwareBranchLabel('folder:g1', 'refs/heads/dev', undefined)).toBe(
      'dev'
    )
  })
})
