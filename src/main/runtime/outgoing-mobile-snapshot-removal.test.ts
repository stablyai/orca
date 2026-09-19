import { expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-types'
import { prepareOutgoingMobileSnapshotRemoval } from './outgoing-mobile-snapshot-removal'

function fixture() {
  const snapshot: RuntimeMobileSessionTabsSnapshot = {
    worktree: 'folder:source',
    publicationEpoch: 'renderer',
    snapshotVersion: 3,
    activeGroupId: null,
    activeTabId: 'tab::source',
    activeTabType: 'terminal',
    tabs: ['source', 'other'].map((id) => ({
      type: 'terminal',
      id: `tab::${id}`,
      parentTabId: 'tab',
      leafId: id,
      ptyId: id,
      title: id,
      isActive: id === 'source',
      parentLayout: {
        root: {
          type: 'split',
          direction: 'vertical',
          first: { type: 'leaf', leafId: 'source' },
          second: { type: 'leaf', leafId: 'other' }
        },
        activeLeafId: 'source',
        expandedLeafId: null,
        ptyIdsByLeafId: { source: 'source', other: 'other' }
      }
    }))
  }
  const snapshots = new Map([[snapshot.worktree, snapshot]])
  const prepare = () => prepareOutgoingMobileSnapshotRemoval(['source'], () => snapshots)
  const replace = vi.fn(
    (expected: RuntimeMobileSessionTabsSnapshot, next: RuntimeMobileSessionTabsSnapshot) => {
      expect(snapshots.get(expected.worktree)).toBe(expected)
      snapshots.set(expected.worktree, next)
      return next
    }
  )
  return { snapshot, snapshots, prepare, replace }
}

it('reuses split retirement to preserve the other pane and repair active selection', () => {
  const { snapshot, snapshots, prepare, replace } = fixture()
  const cleanup = prepare()
  cleanup.apply(replace)
  cleanup.apply(replace)
  const next = snapshots.get(snapshot.worktree)!
  expect(next.snapshotVersion).toBe(4)
  expect(next.tabs).toHaveLength(1)
  expect(next.activeTabId).toBe('tab::other')
  expect(next.tabs[0]).toMatchObject({
    ptyId: 'other',
    parentLayout: { root: { type: 'leaf', leafId: 'other' }, ptyIdsByLeafId: { other: 'other' } }
  })
  expect(next.retiredTerminalSurfaces).toBeUndefined()
  expect(replace).toHaveBeenCalledOnce()
  expect(snapshot.tabs).toHaveLength(2)
})

it('refuses in-place snapshot drift before replacing anything', () => {
  const { snapshot, prepare, replace } = fixture()
  const cleanup = prepare()
  snapshot.snapshotVersion++
  expect(() => cleanup.apply(replace)).toThrow('source_mobile_snapshot_changed')
  expect(replace).not.toHaveBeenCalled()
})

it('refuses a newly introduced source snapshot before replacing the captured snapshot', () => {
  const { snapshot, snapshots, prepare, replace } = fixture()
  const cleanup = prepare()
  snapshots.set('folder:new', { ...snapshot, worktree: 'folder:new' })
  expect(() => cleanup.apply(replace)).toThrow('source_mobile_snapshot_changed')
  expect(replace).not.toHaveBeenCalled()
})

it('refuses parent-layout source references without a matching retireable tab', () => {
  const { snapshot, prepare } = fixture()
  snapshot.tabs = snapshot.tabs.filter((tab) => tab.id === 'tab::other')
  expect(prepare).toThrow('source_mobile_cleanup_incomplete')
})
