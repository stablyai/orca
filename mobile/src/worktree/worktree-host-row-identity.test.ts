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

  it('removes the matching row', () => {
    const only = row('shared', 'ssh:a')

    expect(removeWorktreeRow([only], only)).toEqual([])
  })
})

describe('getWorktreeRowIdentity', () => {
  it('uses the shared host-qualified identity format', () => {
    expect(getWorktreeRowIdentity(row('shared', 'ssh:builder'))).toBe('ssh:builder|shared')
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

  it('keeps first-match behavior when confirmed identities are duplicated', () => {
    const identity = getWorktreeRowIdentity(row('shared', 'ssh:a'))
    const retained = retainLiveSleptWorktreeIdentities(new Set([identity]), [
      row('shared', 'ssh:a', { liveTerminalCount: 0 }),
      row('shared', 'ssh:a', { liveTerminalCount: 1 })
    ])

    expect([...retained]).toEqual([])
  })

  it('indexes confirmed identities once instead of rescanning for every slept row', () => {
    const rowCount = 64
    let worktreeIdReads = 0
    const confirmed = Array.from({ length: rowCount }, (_, index) => {
      const worktree = row(`worktree-${index}`, `ssh:host-${index}`, { liveTerminalCount: 1 })
      Object.defineProperty(worktree, 'worktreeId', {
        configurable: true,
        get: () => {
          worktreeIdReads += 1
          return `worktree-${index}`
        }
      })
      return worktree
    })
    const previous = new Set(
      Array.from({ length: rowCount }, (_, index) => {
        const reversed = rowCount - index - 1
        return `ssh:host-${reversed}|worktree-${reversed}`
      })
    )

    expect(retainLiveSleptWorktreeIdentities(previous, confirmed)).toBe(previous)
    expect(worktreeIdReads).toBe(rowCount)
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
