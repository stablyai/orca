import { describe, expect, it } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import type { Worktree } from '../../shared/worktree/types'
import {
  COMPLETED_WORKSPACE_STATUS_ID,
  DEFAULT_WORKSPACE_STATUS_ID,
  MAIN_WORKTREE_WORKSPACE_STATUS_ID
} from '../../shared/workspace-statuses'
import { settleListedWorkspaceStatuses } from './settle-listed-workspace-status'

const repo = {
  id: 'repo-1',
  path: '/tmp/orca-status-missing',
  displayName: 'orca',
  badgeColor: '#000',
  addedAt: 0,
  kind: 'git'
} as Repo

function worktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'repo-1::/tmp/feature',
    repoId: repo.id,
    path: '/tmp/feature',
    head: '0123456789abcdef',
    branch: 'refs/heads/feature',
    isBare: false,
    isMainWorktree: false,
    displayName: 'feature',
    comment: '',
    linkedIssue: null,
    linkedPR: 7,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    workspaceStatus: DEFAULT_WORKSPACE_STATUS_ID,
    hostId: 'local',
    ...overrides
  }
}

describe('settleListedWorkspaceStatuses', () => {
  it('completes an in-progress worktree when the cached linked review is merged', async () => {
    const writes: string[] = []
    const listed = await settleListedWorkspaceStatuses({
      store: {
        getRepos: () => [repo],
        getGitHubCache: () => ({
          pr: { 'repo-1::feature': { data: { number: 7, state: 'merged' } } }
        }),
        getAllWorktreeMeta: () => ({
          'repo-1::/tmp/feature': { workspaceStatus: DEFAULT_WORKSPACE_STATUS_ID } as never
        }),
        setWorktreeMeta: (id, meta) => {
          writes.push(`${id}:${meta.workspaceStatus}`)
          return meta as never
        }
      },
      worktrees: [worktree()]
    })

    expect(listed[0]?.workspaceStatus).toBe(COMPLETED_WORKSPACE_STATUS_ID)
    expect(writes).toEqual([`repo-1::/tmp/feature:${COMPLETED_WORKSPACE_STATUS_ID}`])
  })

  it('does not treat an unverifiable default-branch comparison as contained', async () => {
    const listed = await settleListedWorkspaceStatuses({
      store: {
        getRepos: () => [repo],
        getGitHubCache: () => ({ pr: {} }),
        getAllWorktreeMeta: () => ({
          'repo-1::/tmp/feature': { workspaceStatus: DEFAULT_WORKSPACE_STATUS_ID } as never
        })
      },
      worktrees: [worktree({ linkedPR: null })]
    })

    expect(listed[0]?.workspaceStatus).toBe(DEFAULT_WORKSPACE_STATUS_ID)
  })

  it('completes when the linked orchestration task is failed and leaves main checkouts off the task machine', async () => {
    const main = worktree({
      id: 'repo-1::/tmp/orca-status-missing',
      path: repo.path,
      isMainWorktree: true,
      displayName: 'orca',
      linkedPR: null
    })
    const feature = worktree()
    const listed = await settleListedWorkspaceStatuses({
      store: {
        getRepos: () => [repo],
        getGitHubCache: () => ({ pr: {} }),
        getAllWorktreeLineage: () => ({
          [feature.id]: { taskId: 'task-1' } as never
        }),
        getAllWorktreeMeta: () => ({
          [feature.id]: { workspaceStatus: DEFAULT_WORKSPACE_STATUS_ID } as never,
          [main.id]: { workspaceStatus: DEFAULT_WORKSPACE_STATUS_ID } as never
        }),
        setWorktreeMeta: (_id, meta) => meta as never
      },
      orchestrationDb: {
        db: {
          prepare: () => ({
            all: () => [{ status: 'failed' }],
            get: () => undefined
          })
        }
      },
      worktrees: [feature, main]
    })

    expect(listed.map((row) => row.workspaceStatus)).toEqual([
      COMPLETED_WORKSPACE_STATUS_ID,
      MAIN_WORKTREE_WORKSPACE_STATUS_ID
    ])
  })

  it('keeps in-progress when a linked task is still dispatched, even if another row is finished', async () => {
    const listed = await settleListedWorkspaceStatuses({
      store: {
        getRepos: () => [repo],
        getGitHubCache: () => ({ pr: {} }),
        getAllWorktreeLineage: () => ({
          'repo-1::/tmp/feature': { taskId: 'task-1' } as never
        }),
        getAllWorktreeMeta: () => ({
          'repo-1::/tmp/feature': { workspaceStatus: DEFAULT_WORKSPACE_STATUS_ID } as never
        })
      },
      orchestrationDb: {
        db: {
          prepare: () => ({
            all: () => [{ status: 'completed' }, { status: 'dispatched' }],
            get: () => undefined
          })
        }
      },
      worktrees: [worktree({ linkedPR: null })]
    })

    expect(listed[0]?.workspaceStatus).toBe(DEFAULT_WORKSPACE_STATUS_ID)
  })
})
