import { describe, expect, it } from 'vitest'
import {
  applyWorktreeRowDisplayState,
  clearConfirmedActiveWorktreeIdentity,
  getWorktreeRowIdentity,
  removeWorktreeRow,
  retainLiveSleptWorktreeIdentities
} from './worktree-host-row-identity'
import type { Worktree } from './workspace-list-types'

function row(worktreeId: string, hostId: string, overrides: Partial<Worktree> = {}): Worktree {
  return { worktreeId, hostId, displayName: worktreeId, ...overrides } as Worktree
}

describe('removeWorktreeRow', () => {
  // Deleting on one host used to clear the other host's identically-named row from the list.
  it('keeps a same-id workspace that lives on another host', () => {
    const local = row('shared', 'host-a')
    const remote = row('shared', 'host-b')

    expect(removeWorktreeRow([local, remote], local)).toEqual([remote])
  })

  it('removes the matching row', () => {
    const only = row('shared', 'host-a')

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
    const pending = getWorktreeRowIdentity(row('shared', 'host-a'))

    expect(
      clearConfirmedActiveWorktreeIdentity(pending, [row('shared', 'host-b', { isActive: true })])
    ).toBe(pending)
    expect(
      clearConfirmedActiveWorktreeIdentity(pending, [row('shared', 'host-a', { isActive: true })])
    ).toBeNull()
  })

  it('retains slept rows only while the same host still has live terminals', () => {
    const local = row('shared', 'host-a')
    const remote = row('shared', 'host-b')
    const retained = retainLiveSleptWorktreeIdentities(
      new Set([getWorktreeRowIdentity(local), getWorktreeRowIdentity(remote)]),
      [
        row('shared', 'host-a', { liveTerminalCount: 0 }),
        row('shared', 'host-b', { liveTerminalCount: 1 })
      ]
    )

    expect([...retained]).toEqual([getWorktreeRowIdentity(remote)])
  })

  it('applies active and slept overrides to the matching host row only', () => {
    const local = row('shared', 'host-a')
    const remote = row('shared', 'host-b')

    const rows = applyWorktreeRowDisplayState(
      [local, remote],
      new Set([getWorktreeRowIdentity(local)]),
      getWorktreeRowIdentity(remote)
    )

    expect(rows).toMatchObject([
      { hostId: 'host-a', liveTerminalCount: 0, status: 'inactive', isActive: false },
      { hostId: 'host-b', isActive: true }
    ])
  })
})
