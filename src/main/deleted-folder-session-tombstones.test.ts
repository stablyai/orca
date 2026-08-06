import { describe, expect, it, vi } from 'vitest'
import type {
  DeletedFolderWorkspaceSessionTombstone,
  PersistedState,
  WorkspaceKey
} from '../shared/types'
import {
  addDeletedFolderTombstoneOverflowEntries,
  getBoundedDeletedFolderTombstoneEvidence,
  getDeletedFolderTombstoneEviction,
  hasDeletedFolderConnectionOverflowEvidence,
  hasDeletedFolderTabOwnerOverflowEvidence,
  hasDeletedFolderWorkspaceKeyOverflowEvidence,
  pruneDeletedFolderTombstoneOverflowBuckets
} from './deleted-folder-session-tombstones'

const NOW = Date.parse('2026-01-15T12:00:00Z')

function tombstone(
  deletedAt = NOW,
  connectionId: string | null = null
): DeletedFolderWorkspaceSessionTombstone {
  return {
    connectionId,
    deletedAt,
    evidenceTruncated: false,
    hostIds: ['local'],
    tabConnectionIdsByHostId: {}
  }
}

describe('deleted folder session tombstones', () => {
  it('does not sort an already-capped tombstone set', () => {
    const tombstones = Object.fromEntries(
      Array.from({ length: 512 }, (_, index) => [`folder:deleted-${index}`, tombstone(NOW - index)])
    ) as NonNullable<PersistedState['deletedFolderWorkspaceSessionTombstones']>
    const sortSpy = vi.spyOn(Array.prototype, 'sort')

    const eviction = getDeletedFolderTombstoneEviction(tombstones, NOW)

    expect(eviction).toEqual({ workspaceKeys: [], overflowEntries: [] })
    expect(sortSpy).not.toHaveBeenCalled()
    sortSpy.mockRestore()
  })

  it('keeps overflow evidence keyed to deleted workspace, tab, and connection identities', () => {
    const workspaceKey = 'folder:deleted' as WorkspaceKey
    const buckets = addDeletedFolderTombstoneOverflowEntries(
      undefined,
      [
        {
          deletedAt: NOW,
          workspaceKey,
          tabOwners: [{ hostId: 'runtime:deleted-host', tabId: 'deleted-tab' }],
          connectionIds: ['deleted-connection']
        }
      ],
      NOW
    )

    expect(hasDeletedFolderWorkspaceKeyOverflowEvidence(buckets, workspaceKey, NOW)).toBe(true)
    expect(
      hasDeletedFolderTabOwnerOverflowEvidence(buckets, 'runtime:deleted-host', 'deleted-tab', NOW)
    ).toBe(true)
    expect(hasDeletedFolderConnectionOverflowEvidence(buckets, 'deleted-connection', NOW)).toBe(
      true
    )
    expect(hasDeletedFolderWorkspaceKeyOverflowEvidence(buckets, 'folder:unrelated', NOW)).toBe(
      false
    )
    expect(
      hasDeletedFolderTabOwnerOverflowEvidence(
        buckets,
        'runtime:unrelated-host',
        'unrelated-tab',
        NOW
      )
    ).toBe(false)
    expect(hasDeletedFolderConnectionOverflowEvidence(buckets, 'unrelated-connection', NOW)).toBe(
      false
    )
  })

  it('expires overflow buckets without cloning active evidence', () => {
    const buckets = addDeletedFolderTombstoneOverflowEntries(
      undefined,
      [{ deletedAt: NOW, workspaceKey: 'folder:deleted' as WorkspaceKey }],
      NOW
    )

    expect(pruneDeletedFolderTombstoneOverflowBuckets(buckets, NOW)).toBe(buckets)
    expect(
      pruneDeletedFolderTombstoneOverflowBuckets(buckets, NOW + 30 * 24 * 60 * 60 * 1000)
    ).toEqual([])
  })

  it('fails open instead of returning probabilistic positives when exact evidence is full', () => {
    const entries = Array.from({ length: 513 }, (_, index) => ({
      deletedAt: NOW,
      workspaceKey: `folder:deleted-${index}` as WorkspaceKey
    }))

    const buckets = addDeletedFolderTombstoneOverflowEntries(undefined, entries, NOW)

    expect(hasDeletedFolderWorkspaceKeyOverflowEvidence(buckets, 'folder:deleted-0', NOW)).toBe(
      true
    )
    expect(hasDeletedFolderWorkspaceKeyOverflowEvidence(buckets, 'folder:deleted-511', NOW)).toBe(
      true
    )
    expect(hasDeletedFolderWorkspaceKeyOverflowEvidence(buckets, 'folder:deleted-512', NOW)).toBe(
      false
    )
    expect(hasDeletedFolderWorkspaceKeyOverflowEvidence(buckets, 'folder:unrelated', NOW)).toBe(
      false
    )
  })

  it('spills discarded tab identities into exact host-scoped evidence', () => {
    const deleted = tombstone()
    deleted.hostIds = ['runtime:deleted-host']
    deleted.tabConnectionIdsByHostId = {
      'runtime:deleted-host': Object.fromEntries(
        Array.from({ length: 257 }, (_, index) => [
          `deleted-tab-${index}`,
          `deleted-connection-${index}`
        ])
      )
    }

    const bounded = getBoundedDeletedFolderTombstoneEvidence(deleted)
    const buckets = addDeletedFolderTombstoneOverflowEntries(
      undefined,
      bounded.overflowEntry ? [bounded.overflowEntry] : [],
      NOW
    )

    expect(bounded.tombstone.evidenceTruncated).toBe(true)
    expect(bounded.tombstone.tabConnectionIdsByHostId['runtime:deleted-host']).not.toHaveProperty(
      'deleted-tab-0'
    )
    expect(
      hasDeletedFolderTabOwnerOverflowEvidence(
        buckets,
        'runtime:deleted-host',
        'deleted-tab-0',
        NOW
      )
    ).toBe(true)
    expect(
      hasDeletedFolderTabOwnerOverflowEvidence(
        buckets,
        'runtime:unrelated-host',
        'deleted-tab-0',
        NOW
      )
    ).toBe(false)
  })
})
