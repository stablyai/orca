import { describe, expect, it } from 'vitest'
import {
  applyWorktreeRowDisplayState,
  clearConfirmedActiveWorktreeIdentity,
  getWorktreeRowIdentity,
  removeWorktreeRow,
  retainLiveSleptWorktreeIdentities
} from './worktree-host-row-identity'
import type { Worktree } from './workspace-list-types'

function row(
  worktreeId: string,
  hostId: Worktree['hostId'],
  overrides: Partial<Worktree> = {}
): Worktree {
  return {
    worktreeId,
    hostId,
    displayName: worktreeId,
    repoId: 'repo',
    repo: 'orca',
    branch: 'feature',
    path: `/workspaces/${worktreeId}`,
    liveTerminalCount: 0,
    hasAttachedPty: false,
    unread: false,
    isPinned: false,
    linkedPR: null,
    ...overrides
  }
}

describe('removeWorktreeRow', () => {
  it('keeps a same-id workspace that lives on another host', () => {
    const local = row('shared', 'ssh:a')
    const remote = row('shared', 'ssh:b')

    expect(removeWorktreeRow([local, remote], local)).toEqual([remote])
  })
})

describe('host-qualified row display state', () => {
  it('clears the optimistic active row only when the same host confirms it', () => {
    const pending = getWorktreeRowIdentity(row('shared', 'ssh:a'))

    expect(
      clearConfirmedActiveWorktreeIdentity(pending, [row('shared', 'ssh:b', { isActive: true })])
    ).toBe(pending)
    expect(
      clearConfirmedActiveWorktreeIdentity(pending, [row('shared', 'ssh:a', { isActive: true })])
    ).toBeNull()
  })

  it('retains slept rows only while the same host still has live terminals', () => {
    const local = row('shared', 'ssh:a')
    const remote = row('shared', 'ssh:b')
    const retained = retainLiveSleptWorktreeIdentities(
      new Set([getWorktreeRowIdentity(local), getWorktreeRowIdentity(remote)]),
      [
        row('shared', 'ssh:a', { liveTerminalCount: 0 }),
        row('shared', 'ssh:b', { liveTerminalCount: 1 })
      ]
    )

    expect([...retained]).toEqual([getWorktreeRowIdentity(remote)])
  })

  it('applies active and slept overrides to the matching host row only', () => {
    const local = row('shared', 'ssh:a')
    const remote = row('shared', 'ssh:b')

    const rows = applyWorktreeRowDisplayState(
      [local, remote],
      new Set([getWorktreeRowIdentity(local)]),
      getWorktreeRowIdentity(remote)
    )

    expect(rows).toMatchObject([
      { hostId: 'ssh:a', liveTerminalCount: 0, status: 'inactive', isActive: false },
      { hostId: 'ssh:b', isActive: true }
    ])
  })
})
