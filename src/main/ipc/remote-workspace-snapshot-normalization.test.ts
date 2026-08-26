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
})
