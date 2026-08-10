import { beforeEach, describe, expect, it } from 'vitest'
import type {
  RemoteWorkspaceSession,
  RemoteWorkspaceSnapshot
} from '../../shared/remote-workspace-types'
import type { DirectSshAuthority, SshProviderEpoch } from '../../shared/ssh-types'
import {
  REMOTE_WORKSPACE_SNAPSHOT_CACHE_MAX_ENTRIES,
  _getRemoteWorkspaceCacheSizesForTests,
  _getRemoteWorkspaceSnapshotForTests,
  _rememberRemoteWorkspaceSnapshotForTests,
  _resetRemoteWorkspaceCachesForTests
} from './remote-workspace'

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

function authority(targetId: string): DirectSshAuthority {
  return {
    targetId,
    providerEpoch: `epoch-${targetId}` as SshProviderEpoch,
    connectionGeneration: 1
  }
}

describe('remote workspace snapshot cache', () => {
  beforeEach(() => {
    _resetRemoteWorkspaceCachesForTests()
  })

  it('LRU-evicts old target snapshots', () => {
    for (let i = 0; i <= REMOTE_WORKSPACE_SNAPSHOT_CACHE_MAX_ENTRIES; i++) {
      _rememberRemoteWorkspaceSnapshotForTests(
        authority(`target-${i}`),
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
    expect(_getRemoteWorkspaceSnapshotForTests(authority('target-0'))).toBeUndefined()
    expect(
      _getRemoteWorkspaceSnapshotForTests(authority('target-1'))?.session.activeWorktreePath
    ).toBe('/repo-1')
  })

  it('refreshes snapshot recency on cache reads', () => {
    for (let i = 0; i < REMOTE_WORKSPACE_SNAPSHOT_CACHE_MAX_ENTRIES; i++) {
      _rememberRemoteWorkspaceSnapshotForTests(
        authority(`target-${i}`),
        snapshot(emptyRemoteWorkspaceSession())
      )
    }

    expect(_getRemoteWorkspaceSnapshotForTests(authority('target-0'))).toBeDefined()
    _rememberRemoteWorkspaceSnapshotForTests(
      authority('target-new'),
      snapshot(emptyRemoteWorkspaceSession())
    )

    expect(_getRemoteWorkspaceSnapshotForTests(authority('target-0'))).toBeDefined()
    expect(_getRemoteWorkspaceSnapshotForTests(authority('target-1'))).toBeUndefined()
  })

  it('does not return a snapshot across provider authority rotation', () => {
    const original = authority('target-1')
    const replacement = {
      ...original,
      providerEpoch: 'epoch-replacement' as SshProviderEpoch,
      connectionGeneration: 2
    }
    _rememberRemoteWorkspaceSnapshotForTests(original, snapshot(emptyRemoteWorkspaceSession(), 99))

    expect(_getRemoteWorkspaceSnapshotForTests(replacement)).toBeUndefined()
  })
})
