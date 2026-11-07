import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../shared/repo-types'
import type { WorkspaceLineage } from '../../../shared/worktree/lineage-types'
import type { Worktree } from '../../../shared/worktree/types'
import { projectWorktreeLineageWithHostPeers } from './worktree-lineage-host-peers'

const repo: Repo = { id: 'r', path: '/r', displayName: 'r', badgeColor: '', addedAt: 0 }

function row(id: string): Worktree {
  return {
    id,
    instanceId: `${id}#1`,
    repoId: 'r',
    path: id.split('::')[1],
    head: 'abc',
    branch: 'refs/heads/main',
    isBare: false,
    isMainWorktree: false,
    displayName: id,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0
  }
}

const record: WorkspaceLineage = {
  childWorkspaceKey: 'worktree:r::/r/child',
  childInstanceId: 'r::/r/child#1',
  parentWorkspaceKey: 'folder:f-1',
  parentInstanceId: 'f-1',
  origin: 'manual',
  capture: { source: 'manual-action', confidence: 'explicit' },
  createdAt: 1
}

describe('projectWorktreeLineageWithHostPeers', () => {
  it('attaches each listed row’s own folder parent, so a twin on another host keeps it', () => {
    const projected = projectWorktreeLineageWithHostPeers(
      {
        getRepos: () => [repo],
        getAllWorktreeMeta: () => ({}),
        getAllWorktreeMetaForHost: () => ({}),
        getAllWorktreeLineage: () => ({}),
        getAllWorkspaceLineage: () => ({ 'worktree:r::/r/child': record })
      },
      repo,
      [row('r::/r/child'), row('r::/r/other')]
    )
    expect(projected.map((entry) => [entry.id, entry.workspaceLineage])).toEqual([
      ['r::/r/child', record],
      ['r::/r/other', null]
    ])
  })
})
