import { describe, expect, it } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../shared/runtime-types'
import type { PersistedMobileClientTabSelection } from '../../shared/types'
import { ClientSessionTabSelectionStore } from './client-session-tab-selection'
import {
  isMobileTabSelectionIdRetainable,
  MOBILE_TAB_SELECTION_ID_MAX_BYTES,
  MOBILE_TAB_SELECTION_MAX_BYTES_PER_CLIENT,
  MOBILE_TAB_SELECTION_MAX_CLIENTS,
  MOBILE_TAB_SELECTION_MAX_GROUPS_PER_WORKTREE,
  MOBILE_TAB_SELECTION_MAX_WORKTREES_PER_CLIENT,
  mobileTabSelectionRetainedBytes,
  normalizePersistedMobileClientTabSelections
} from './client-session-tab-selection-persistence'

function selection(
  activeTabIdByGroupId: Readonly<Record<string, string>> = {}
): PersistedMobileClientTabSelection {
  return { activeTabId: 'browser-1', activeGroupId: 'group-1', activeTabIdByGroupId }
}

function snapshot(worktree: string): RuntimeMobileSessionTabsResult {
  return {
    worktree,
    publicationEpoch: 'renderer:1',
    snapshotVersion: 1,
    activeGroupId: 'group-1',
    activeTabId: 'browser-1',
    activeTabType: 'browser',
    tabGroups: [{ id: 'group-1', activeTabId: 'browser-1', tabOrder: ['browser-1'] }],
    tabs: [
      {
        type: 'browser',
        id: 'browser-1',
        browserWorkspaceId: 'browser-workspace',
        browserPageId: 'page-1',
        title: 'Browser',
        url: 'about:blank',
        loading: false,
        canGoBack: false,
        canGoForward: false,
        isActive: true
      }
    ]
  }
}

describe('client session-tab selection retention bounds', () => {
  it('keeps the newest persisted clients without changing accepted selections', () => {
    const clients = Object.fromEntries(
      Array.from({ length: MOBILE_TAB_SELECTION_MAX_CLIENTS + 2 }, (_, index) => [
        `device-${index}`,
        { 'wt-1': selection() }
      ])
    )

    const normalized = normalizePersistedMobileClientTabSelections(clients)

    expect(Object.keys(normalized)).toHaveLength(MOBILE_TAB_SELECTION_MAX_CLIENTS)
    expect(Object.keys(normalized).at(0)).toBe('device-2')
    expect(normalized[`device-${MOBILE_TAB_SELECTION_MAX_CLIENTS + 1}`]?.['wt-1']).toEqual(
      selection()
    )
  })

  it('keeps the newest worktrees and group selections within each client', () => {
    const groups = Object.fromEntries(
      Array.from({ length: MOBILE_TAB_SELECTION_MAX_GROUPS_PER_WORKTREE + 2 }, (_, index) => [
        `group-${index}`,
        `tab-${index}`
      ])
    )
    const worktrees = Object.fromEntries(
      Array.from({ length: MOBILE_TAB_SELECTION_MAX_WORKTREES_PER_CLIENT + 2 }, (_, index) => [
        `wt-${index}`,
        selection(index === MOBILE_TAB_SELECTION_MAX_WORKTREES_PER_CLIENT + 1 ? groups : {})
      ])
    )

    const normalized = normalizePersistedMobileClientTabSelections({ 'device-1': worktrees })
    const retainedWorktrees = normalized['device-1']!
    const retainedGroups =
      retainedWorktrees[`wt-${MOBILE_TAB_SELECTION_MAX_WORKTREES_PER_CLIENT + 1}`]!
        .activeTabIdByGroupId

    expect(Object.keys(retainedWorktrees)).toHaveLength(
      MOBILE_TAB_SELECTION_MAX_WORKTREES_PER_CLIENT
    )
    expect(Object.keys(retainedWorktrees).at(0)).toBe('wt-2')
    expect(Object.keys(retainedGroups)).toHaveLength(MOBILE_TAB_SELECTION_MAX_GROUPS_PER_WORKTREE)
    expect(Object.keys(retainedGroups).at(0)).toBe('group-2')
  })

  it('bounds clients and worktrees created during the current runtime', () => {
    const clientStore = new ClientSessionTabSelectionStore()
    for (let index = 0; index <= MOBILE_TAB_SELECTION_MAX_CLIENTS; index++) {
      clientStore.activate(snapshot('wt-1'), `device-${index}`, 'browser-1')
    }
    const retainedClients = clientStore.serialize()

    expect(Object.keys(retainedClients)).toHaveLength(MOBILE_TAB_SELECTION_MAX_CLIENTS)
    expect(retainedClients['device-0']).toBeUndefined()
    expect(retainedClients[`device-${MOBILE_TAB_SELECTION_MAX_CLIENTS}`]).toBeDefined()

    const worktreeStore = new ClientSessionTabSelectionStore()
    for (let index = 0; index <= MOBILE_TAB_SELECTION_MAX_WORKTREES_PER_CLIENT; index++) {
      worktreeStore.activate(snapshot(`wt-${index}`), 'device-1', 'browser-1')
    }
    const retainedWorktrees = worktreeStore.serialize()['device-1']!

    expect(Object.keys(retainedWorktrees)).toHaveLength(
      MOBILE_TAB_SELECTION_MAX_WORKTREES_PER_CLIENT
    )
    expect(retainedWorktrees['wt-0']).toBeUndefined()
    expect(retainedWorktrees[`wt-${MOBILE_TAB_SELECTION_MAX_WORKTREES_PER_CLIENT}`]).toBeDefined()
  })

  it('rejects relay-sized client and worktree ids instead of retaining them', () => {
    const oversizedId = 'x'.repeat(MOBILE_TAB_SELECTION_ID_MAX_BYTES + 1)
    expect(isMobileTabSelectionIdRetainable(oversizedId)).toBe(false)
    expect(
      normalizePersistedMobileClientTabSelections({
        [oversizedId]: { 'wt-1': selection() },
        'device-1': { [oversizedId]: selection() }
      })
    ).toEqual({})

    const store = new ClientSessionTabSelectionStore()
    const ordinarySnapshot = snapshot('wt-1')
    expect(store.activate(ordinarySnapshot, oversizedId, 'browser-1')).toBe(ordinarySnapshot)
    const oversizedWorktreeSnapshot = snapshot(oversizedId)
    expect(store.activate(oversizedWorktreeSnapshot, 'device-1', 'browser-1')).toBe(
      oversizedWorktreeSnapshot
    )
    expect(store.serialize()).toEqual({})
  })

  it('retains newest worktree selections within the per-client byte budget', () => {
    const fixedSizeId = (prefix: string, index: number): string => {
      const label = `${prefix}-${index}-`
      return `${label}${'x'.repeat(MOBILE_TAB_SELECTION_ID_MAX_BYTES - label.length)}`
    }
    const groups = Object.fromEntries(
      Array.from({ length: MOBILE_TAB_SELECTION_MAX_GROUPS_PER_WORKTREE }, (_, index) => [
        fixedSizeId('group', index),
        fixedSizeId('tab', index)
      ])
    )
    const normalized = normalizePersistedMobileClientTabSelections({
      'device-1': Object.fromEntries(
        Array.from({ length: 10 }, (_, index) => [`wt-${index}`, selection(groups)])
      )
    })
    const retained = normalized['device-1']!
    const retainedBytes = Object.entries(retained).reduce(
      (total, [worktreeId, value]) => total + mobileTabSelectionRetainedBytes(worktreeId, value),
      0
    )

    expect(retainedBytes).toBeLessThanOrEqual(MOBILE_TAB_SELECTION_MAX_BYTES_PER_CLIENT)
    expect(retained['wt-0']).toBeUndefined()
    expect(retained['wt-9']).toBeDefined()
  })
})
