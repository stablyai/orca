import { beforeEach, describe, expect, it } from 'vitest'
import type {
  RemoteWorkspaceSession,
  RemoteWorkspaceSnapshot
} from '../../shared/remote-workspace-types'
import {
  _getRemoteWorkspaceCacheSizesForTests,
  _resetRemoteWorkspaceCachesForTests
} from './remote-workspace'
import {
  REMOTE_WORKSPACE_SNAPSHOT_CACHE_MAX_ENTRIES,
  _getRemoteWorkspaceSnapshotForTests,
  _rememberRemoteWorkspaceSnapshotForTests,
  cachedRemoteWorkspaceSnapshotAuthorizesRevision,
  rememberLocallyPatchedRemoteWorkspaceSnapshot,
  rememberRemoteWorkspaceSnapshot
} from './remote-workspace-snapshot-cache'

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

describe('remote workspace snapshot cache', () => {
  beforeEach(() => {
    _resetRemoteWorkspaceCachesForTests()
  })

  it('LRU-evicts old target snapshots', () => {
    for (let i = 0; i <= REMOTE_WORKSPACE_SNAPSHOT_CACHE_MAX_ENTRIES; i++) {
      _rememberRemoteWorkspaceSnapshotForTests(
        `target-${i}`,
        snapshot({
          activeWorktreePath: `/repo-${i}`,
          activeTabId: null,
          tabsByWorktreePath: {},
          terminalLayoutsByTabId: {}
        })
      )
    }

    expect(_getRemoteWorkspaceCacheSizesForTests().snapshots).toBe(
      REMOTE_WORKSPACE_SNAPSHOT_CACHE_MAX_ENTRIES
    )
    expect(_getRemoteWorkspaceSnapshotForTests('target-0')).toBeUndefined()
    expect(cachedRemoteWorkspaceSnapshotAuthorizesRevision('target-0', 7)).toBe(false)
    expect(_getRemoteWorkspaceSnapshotForTests('target-1')?.session.activeWorktreePath).toBe(
      '/repo-1'
    )
  })

  it('refreshes snapshot recency on cache reads', () => {
    for (let i = 0; i < REMOTE_WORKSPACE_SNAPSHOT_CACHE_MAX_ENTRIES; i++) {
      _rememberRemoteWorkspaceSnapshotForTests(
        `target-${i}`,
        snapshot(emptyRemoteWorkspaceSession())
      )
    }

    expect(_getRemoteWorkspaceSnapshotForTests('target-0')).toBeDefined()
    _rememberRemoteWorkspaceSnapshotForTests('target-new', snapshot(emptyRemoteWorkspaceSession()))

    expect(_getRemoteWorkspaceSnapshotForTests('target-0')).toBeDefined()
    expect(_getRemoteWorkspaceSnapshotForTests('target-1')).toBeUndefined()
  })

  it('keeps contiguous local patch bases authorized until the host changes', () => {
    rememberRemoteWorkspaceSnapshot('target-1', snapshot(emptyRemoteWorkspaceSession(), 7))
    rememberLocallyPatchedRemoteWorkspaceSnapshot(
      'target-1',
      snapshot(emptyRemoteWorkspaceSession(), 8)
    )
    rememberLocallyPatchedRemoteWorkspaceSnapshot(
      'target-1',
      snapshot(emptyRemoteWorkspaceSession(), 9)
    )

    expect(cachedRemoteWorkspaceSnapshotAuthorizesRevision('target-1', 7)).toBe(true)
    expect(cachedRemoteWorkspaceSnapshotAuthorizesRevision('target-1', 8)).toBe(true)
    expect(cachedRemoteWorkspaceSnapshotAuthorizesRevision('target-1', 9)).toBe(true)

    rememberRemoteWorkspaceSnapshot('target-1', snapshot(emptyRemoteWorkspaceSession(), 10))

    expect(cachedRemoteWorkspaceSnapshotAuthorizesRevision('target-1', 9)).toBe(false)
    expect(cachedRemoteWorkspaceSnapshotAuthorizesRevision('target-1', 10)).toBe(true)
  })

  it('keeps the observation token stable when an unchanged revision is re-read', () => {
    const first = rememberRemoteWorkspaceSnapshot(
      'target-1',
      snapshot(emptyRemoteWorkspaceSession(), 7)
    )
    const second = rememberRemoteWorkspaceSnapshot(
      'target-1',
      snapshot(emptyRemoteWorkspaceSession(), 7)
    )

    expect(second.hostObservationToken).toBe(first.hostObservationToken)
    expect(cachedRemoteWorkspaceSnapshotAuthorizesRevision('target-1', 7)).toBe(true)
  })

  it('rotates the observation token when same-revision content changes', () => {
    const first = rememberRemoteWorkspaceSnapshot(
      'target-1',
      snapshot(emptyRemoteWorkspaceSession(), 7)
    )
    const second = rememberRemoteWorkspaceSnapshot(
      'target-1',
      snapshot(
        {
          ...emptyRemoteWorkspaceSession(),
          activeTabId: 'changed'
        },
        7
      )
    )

    expect(second.hostObservationToken).not.toBe(first.hostObservationToken)
  })

  it('keeps local patch authority across equivalent normalized relay reads', () => {
    const base = rememberRemoteWorkspaceSnapshot(
      'target-1',
      snapshot(emptyRemoteWorkspaceSession(), 7)
    )
    const locallyPatched = rememberLocallyPatchedRemoteWorkspaceSnapshot(
      'target-1',
      snapshot(
        {
          ...emptyRemoteWorkspaceSession(),
          activeWorktreePathsOnShutdown: [],
          activeTabIdByWorktreePath: {},
          remoteSessionIdsByTabId: {},
          lastVisitedAtByWorktreePath: {},
          defaultTerminalTabsAppliedByWorktreePath: {}
        },
        8
      )
    )
    const relayRead = rememberRemoteWorkspaceSnapshot(
      'target-1',
      snapshot(emptyRemoteWorkspaceSession(), 8)
    )

    expect(locallyPatched.hostObservationToken).toBe(base.hostObservationToken)
    expect(relayRead.hostObservationToken).toBe(locallyPatched.hostObservationToken)
  })
})
