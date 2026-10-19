import { describe, expect, it } from 'vitest'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { Repo } from '../../../shared/repo-types'
import {
  hostWorktreeTarget,
  type HostWorktreeTarget
} from '../../../shared/worktree/host-qualified-identity'
import { readSortStamps, writeSortStamps, writeUnreadFlag } from './sort-stamp-records'

const WT = 'dup::/wt'
type Row = { lastActivityAt: number; isUnread?: boolean; hostId?: ExecutionHostId }

function repo(overrides: Partial<Repo>): Repo {
  return {
    id: 'dup',
    path: '/wt',
    displayName: 'dup',
    badgeColor: '#000',
    addedAt: 1,
    ...overrides
  }
}

// Mirrors the persistence store: the raw-id row belongs to whichever twin wrote first.
function twinStore(repos: Repo[]) {
  const byHost = new Map<string, Row>()
  let rawOwner: ExecutionHostId | undefined
  return {
    byHost,
    getRepos: () => repos,
    getWorktreeMeta: (id: string) => (id === WT && rawOwner ? byHost.get(rawOwner) : undefined),
    getWorktreeMetaForHost: (id: string, hostId: ExecutionHostId) =>
      id === WT ? byHost.get(hostId) : undefined,
    setWorktreeMeta: (target: HostWorktreeTarget, updates: Partial<Row>) => {
      rawOwner ??= target.hostId
      byHost.set(target.hostId, {
        ...(byHost.get(target.hostId) ?? { lastActivityAt: 0 }),
        ...updates,
        hostId: target.hostId
      })
    }
  }
}

describe('sort stamps and unread for a local pane of a same-id twin', () => {
  it('reads and writes the local copy, not the twin that wrote first', () => {
    const store = twinStore([repo({}), repo({ connectionId: 'box' })])
    store.setWorktreeMeta(hostWorktreeTarget({ id: WT, hostId: 'ssh:box' }), {
      lastActivityAt: 5
    })
    store.setWorktreeMeta(hostWorktreeTarget({ id: WT, hostId: 'local' }), {
      lastActivityAt: 1
    })
    const localPane = { worktreeId: WT, sshHostId: null }

    expect(readSortStamps(store, localPane)?.recentAt).toBe(1)
    writeSortStamps(store, localPane, { recentAt: 9 })
    expect(writeUnreadFlag(store, localPane, true)).toBe(true)

    expect(store.byHost.get('local')).toMatchObject({ lastActivityAt: 9, isUnread: true })
    expect(store.byHost.get('ssh:box')).toMatchObject({ lastActivityAt: 5 })
    expect(store.byHost.get('ssh:box')?.isUnread).toBeUndefined()
  })

  it('keeps the stamped row when the repo lives on one host', () => {
    const store = twinStore([repo({ connectionId: 'box' })])
    store.setWorktreeMeta(hostWorktreeTarget({ id: WT, hostId: 'ssh:box' }), {
      lastActivityAt: 5
    })

    writeSortStamps(store, { worktreeId: WT, sshHostId: null }, { recentAt: 9 })

    expect(store.byHost.get('ssh:box')?.lastActivityAt).toBe(9)
    expect(store.byHost.has('local')).toBe(false)
  })
})
