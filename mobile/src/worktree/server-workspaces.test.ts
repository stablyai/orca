import { describe, expect, it } from 'vitest'
import type { MobileRelayHost } from '../../../src/shared/mobile-relay-hosts-contract'
import { applyServerWorkspaces, NO_SERVER_WORKSPACES } from './server-workspaces'
import type { Worktree } from './workspace-list-types'

const host: MobileRelayHost = {
  hostId: 'runtime:env-1',
  label: 'Box',
  health: 'available',
  relay: 'ready'
}

function row(worktreeId: string): Worktree {
  return {
    worktreeId,
    repoId: 'repo-1',
    hostId: host.hostId,
    repo: 'orca',
    branch: 'main',
    displayName: worktreeId,
    path: `/srv/${worktreeId}`,
    liveTerminalCount: 0,
    hasAttachedPty: false,
    preview: '',
    unread: false,
    isPinned: false,
    linkedPR: null
  }
}

describe('applyServerWorkspaces', () => {
  it('keeps the same hosts list when only the rows change', () => {
    const first = applyServerWorkspaces(NO_SERVER_WORKSPACES, { hosts: [host], rows: [[row('a')]] })
    const next = applyServerWorkspaces(first, {
      hosts: [{ ...host }],
      rows: [[row('a'), row('b')]]
    })
    expect(next.worktrees.map((worktree) => worktree.worktreeId)).toEqual(['a', 'b'])
    expect(next.hosts).toBe(first.hosts)
    const relabeled = applyServerWorkspaces(next, {
      hosts: [{ ...host, relay: 'unavailable' }],
      rows: [null]
    })
    expect(relabeled.hosts).not.toBe(first.hosts)
  })
})
