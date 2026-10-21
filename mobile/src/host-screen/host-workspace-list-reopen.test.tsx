import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Platform: { OS: 'ios' },
  Pressable: 'Pressable',
  RefreshControl: 'RefreshControl',
  SectionList: 'SectionList',
  StyleSheet: { create: (styles: unknown) => styles },
  Text: 'Text',
  View: 'View'
}))
vi.mock('lucide-react-native', () => ({
  ChevronDown: 'ChevronDown',
  ChevronRight: 'ChevronRight',
  Pin: 'Pin',
  X: 'X'
}))
vi.mock('../components/AuthFailedBanner', () => ({ AuthFailedBanner: 'AuthFailedBanner' }))
vi.mock('../components/HostDiagnosticsLink', () => ({ HostDiagnosticsLink: 'HostDiagnosticsLink' }))
vi.mock('../components/MobileRepoIcon', () => ({ MobileRepoIcon: 'MobileRepoIcon' }))
vi.mock('../components/MobileSearchField', () => ({ MobileSearchField: 'MobileSearchField' }))
vi.mock('../components/NewWorkspaceFab', () => ({
  NewWorkspaceFab: 'NewWorkspaceFab',
  FAB_SIZE: 56
}))
vi.mock('../components/WorktreeListRow', () => ({ WorktreeListRow: 'WorktreeListRow' }))

import { HostWorkspaceList } from './host-workspace-list'
import { INITIAL_MOBILE_VIEW } from '../worktree/workspace-view-settings'

/** A host whose feed this page cannot read: the notice, above the rows the page already holds. */
function listWith(rows: number) {
  const section = {
    key: 'all',
    title: '',
    data: Array.from({ length: rows }, (_, i) => ({ id: `w${i}` }))
  }
  const sections = rows > 0 ? [section] : []
  const controller = {
    actions: { openWorktreeSession: () => {}, openNewWorktreeModal: () => {} },
    activeWorktreeScroll: { sectionListRef: { current: null }, onScrollToIndexFailed: () => {} },
    catalog: { refreshing: false, onRefresh: () => {} },
    collapsedGroups: new Set(),
    connState: 'connected',
    contentMaxWidth: 600,
    displayWorktrees: section.data,
    embedded: true,
    feed: { kind: 'reopen' },
    forceReconnectHost: () => {},
    hostId: 'host-1',
    insets: { bottom: 0 },
    isReadOnly: false,
    isWideLayout: false,
    noticeParam: undefined,
    now: 0,
    reconnectAttempts: 0,
    relayRecovery: { pairingRejected: false },
    routeNotice: '',
    router: { push: () => {} },
    sectionsResult: { rawSections: sections, sections, repoById: new Map() },
    setDismissedNotice: () => {},
    settings: { activeFilterCount: 0, pendingViewChanges: { pending: [], stale: false } },
    state: {
      actionError: '',
      setActionError: () => {},
      catalogError: null,
      view: { ...INITIAL_MOBILE_VIEW, groupBy: 'none' },
      search: '',
      showSearch: false,
      worktreesLoaded: true
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every row and header below the notice is mocked to a host string here, so the list reads only the fields named above.
  return { controller } as unknown as Parameters<typeof HostWorkspaceList>[0]
}

function render(rows: number): ReactTestRenderer {
  const rendered: { tree: ReactTestRenderer | null } = { tree: null }
  act(() => {
    rendered.tree = create(createElement(HostWorkspaceList, listWith(rows)))
  })
  if (rendered.tree === null) {
    throw new Error('the list did not render')
  }
  return rendered.tree
}

function texts(tree: ReactTestRenderer): unknown[] {
  return tree.root
    .findAll((node) => String(node.type) === 'Text')
    .map((node) => node.props.children)
}

describe('a host whose sidebar feed this page cannot read', () => {
  it('keeps the rows the page holds on screen under "Reopen to update"', () => {
    const tree = render(2)
    expect(texts(tree)).toContain('Reopen to update')
    const [list] = tree.root.findAll((node) => String(node.type) === 'SectionList')
    expect(list?.props.sections[0].data).toHaveLength(2)
  })

  it('says only "Reopen to update" when the page holds no rows yet', () => {
    const tree = render(0)
    expect(texts(tree)).toContain('Reopen to update')
    expect(tree.root.findAll((node) => String(node.type) === 'SectionList')).toEqual([])
  })
})
