import { describe, expect, it } from 'vitest'
import type {
  RemoteWorkspaceSession,
  RemoteWorkspaceSnapshot
} from '../../shared/remote-workspace-types'
import {
  normalizeSnapshot,
  remoteWorkspaceSessionMatchesSnapshot
} from './remote-workspace-snapshot-normalization'

function emptyRemoteWorkspaceSession(): RemoteWorkspaceSession {
  return {
    activeWorktreePath: null,
    activeTabId: null,
    tabsByWorktreePath: {},
    terminalLayoutsByTabId: {}
  }
}

function snapshot(session: RemoteWorkspaceSession, revision = 7): RemoteWorkspaceSnapshot {
  return {
    namespace: 'target',
    revision,
    updatedAt: 123,
    schemaVersion: 1,
    session
  }
}

describe('remote workspace snapshot normalization: close tombstones', () => {
  it('closedTabTombstonesByTabId survives normalizeSnapshot', () => {
    const raw = snapshot({
      ...emptyRemoteWorkspaceSession(),
      closedTabTombstonesByTabId: {
        'tab-ghost': { closedAt: 111, worktreePath: '/home/user/bug-cats' }
      }
    })

    const normalized = normalizeSnapshot(raw, 'target')

    expect(normalized.session.closedTabTombstonesByTabId).toEqual({
      'tab-ghost': { closedAt: 111, worktreePath: '/home/user/bug-cats' }
    })
  })

  it('remoteWorkspaceSessionMatchesSnapshot reports NOT-matching when only tombstones differ', () => {
    const base = snapshot(emptyRemoteWorkspaceSession())
    const sessionWithTombstone: RemoteWorkspaceSession = {
      ...emptyRemoteWorkspaceSession(),
      closedTabTombstonesByTabId: {
        'tab-ghost': { closedAt: 111, worktreePath: '/home/user/bug-cats' }
      }
    }

    expect(remoteWorkspaceSessionMatchesSnapshot(base, sessionWithTombstone)).toBe(false)
  })

  it('drops invalid tombstone entries while keeping the valid one', () => {
    const raw = snapshot({
      ...emptyRemoteWorkspaceSession(),
      closedTabTombstonesByTabId: {
        'tab-valid': { closedAt: 111, worktreePath: '/home/user/bug-cats' },
        'tab-null': null,
        'tab-missing-worktree-path': { closedAt: 222 },
        'tab-bad-closed-at': { closedAt: 'x', worktreePath: '/home/user/bug-cats' }
      } as never
    })

    const normalized = normalizeSnapshot(raw, 'target')

    expect(normalized.session.closedTabTombstonesByTabId).toEqual({
      'tab-valid': { closedAt: 111, worktreePath: '/home/user/bug-cats' }
    })
  })

  it('normalizes an all-invalid tombstone map to undefined', () => {
    const raw = snapshot({
      ...emptyRemoteWorkspaceSession(),
      closedTabTombstonesByTabId: {
        'tab-null': null,
        'tab-missing-worktree-path': { closedAt: 222 }
      } as never
    })

    const normalized = normalizeSnapshot(raw, 'target')

    expect(normalized.session.closedTabTombstonesByTabId).toBeUndefined()
  })
})
