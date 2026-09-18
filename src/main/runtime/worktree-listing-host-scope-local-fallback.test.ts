import { describe, expect, it } from 'vitest'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import type { Repo } from '../../shared/repo-types'
import type { RuntimeWorktreeRecord } from '../../shared/runtime-worktree-contracts'
import {
  buildWorktreeListingHostScope,
  buildWorktreeListingPage
} from './worktree-listing-host-scope'

const PLAIN_LOCAL_REPO: Repo = {
  id: 'repo-plain-local',
  path: '/tmp/plain-local',
  displayName: 'plain-local',
  badgeColor: '#000000',
  addedAt: 0
}

function plainLocalWorktree(path: string): RuntimeWorktreeRecord {
  const git = {
    path,
    head: 'abc123',
    branch: 'refs/heads/main',
    isBare: false,
    isMainWorktree: true
  }
  return {
    id: `${PLAIN_LOCAL_REPO.id}::${path}`,
    repoId: PLAIN_LOCAL_REPO.id,
    displayName: path,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    parentWorktreeId: null,
    childWorktreeIds: [],
    lineage: null,
    ...git,
    git
  }
}

describe('buildWorktreeListingHostScope', () => {
  it('counts plain local rows under LOCAL_EXECUTION_HOST_ID', () => {
    const rows = [
      plainLocalWorktree('/tmp/plain-local/wt-a'),
      plainLocalWorktree('/tmp/plain-local/wt-b')
    ]

    const hostScope = buildWorktreeListingHostScope({
      pageHostIds: rows.map((row) => row.hostId),
      matchedHostIds: rows.map((row) => row.hostId),
      knownHostIds: []
    })

    expect(hostScope.hostIds).toEqual([LOCAL_EXECUTION_HOST_ID])
    expect(hostScope.omittedHostIds).toEqual([])
  })
})

describe('buildWorktreeListingPage', () => {
  it('keeps plain local rows in hostScope.hostIds', () => {
    const rows = [plainLocalWorktree('/tmp/plain-local/wt-a')]

    const result = buildWorktreeListingPage(rows, 200, [])

    expect(result.hostScope.hostIds).toEqual([LOCAL_EXECUTION_HOST_ID])
    expect(result.hostScope.omittedHostIds).toEqual([])
  })
})
