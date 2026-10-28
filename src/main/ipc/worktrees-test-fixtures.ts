import type { DetectedWorktreeListResult, GitWorktreeInfo } from '../../shared/worktree/types'
import { reviewHeadRemoteRefComponent } from '../../shared/review-head-tracking-ref'
import { listWorktreesMock, setPlatform } from './worktrees-test-module-mocks'
import { store } from './worktrees-test-ipc-surface'

export const ORIGIN_REMOTE_URL = 'git@github.com:org/repo.git'
export const ORIGIN_HEAD_COMPONENT = reviewHeadRemoteRefComponent('origin', ORIGIN_REMOTE_URL)

export const createdWorktreeList = [
  {
    path: '/workspace/improve-dashboard',
    head: 'abc123',
    branch: 'improve-dashboard',
    isBare: false,
    isMainWorktree: false
  }
]

export function mockKnownFeatureWorktree(
  path = '/workspace/feature-wt',
  repoPath = '/workspace/repo'
): GitWorktreeInfo[] {
  const worktrees: GitWorktreeInfo[] = [
    {
      path: repoPath,
      head: 'main',
      branch: 'main',
      isBare: false,
      isMainWorktree: true
    },
    {
      path,
      head: 'feature',
      branch: 'feature',
      isBare: false,
      isMainWorktree: false
    }
  ]
  listWorktreesMock.mockResolvedValue(worktrees)
  return worktrees
}

export function makeWorktreeMeta(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    displayName: '',
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

export function mockSelectedWslProjectRuntime(): void {
  setPlatform('win32')
  store.getProjects.mockReturnValue([
    {
      id: 'project-1',
      displayName: 'repo',
      badgeColor: '#000',
      sourceRepoIds: ['repo-1'],
      localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' },
      createdAt: 0,
      updatedAt: 0
    }
  ])
}

function isDetectedWorktreeListResult(value: unknown): value is DetectedWorktreeListResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    'authoritative' in value &&
    typeof value.authoritative === 'boolean' &&
    'worktrees' in value &&
    Array.isArray(value.worktrees)
  )
}

export function expectDetectedWorktreeListResult(value: unknown): DetectedWorktreeListResult {
  if (!isDetectedWorktreeListResult(value)) {
    throw new Error(`Expected a detected worktree list result, got ${JSON.stringify(value)}`)
  }
  return value
}
