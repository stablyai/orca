import { createElement } from 'react'
import { act, create as createRenderer, type ReactTestRenderer } from 'react-test-renderer'

import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Platform: { OS: 'ios' },
  Pressable: 'Pressable',
  RefreshControl: 'RefreshControl',
  Animated: { SectionList: 'SectionList' },
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
vi.mock('../components/WorktreeListRow', () => ({ WorktreeListRow: 'WorktreeListRow' }))

import { HostWorkspaceList } from './host-workspace-list'
import { INITIAL_MOBILE_VIEW } from '../worktree/workspace-view-settings'

const renderers = new Set<ReturnType<typeof createRenderer>>()
function create(...args: Parameters<typeof createRenderer>): ReturnType<typeof createRenderer> {
  const renderer = createRenderer(...args)
  renderers.add(renderer)
  return renderer
}
function unmountRenderers(): void {
  act(() => {
    for (const renderer of renderers) {
      renderer.unmount()
    }
  })
  renderers.clear()
}

function listWith(rows: number) {
  const section = {
    key: 'all',
    title: '',
    data: Array.from({ length: rows }, (_, i) => ({ id: `w${i}` }))
  }
  const sections = rows > 0 ? [section] : []
  const controller = {
    actions: { openWorktreeSession: () => {}, openCreateMenu: () => {} },
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
      worktreesLoaded: true
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every row and header below the notice is mocked to a host string here, so the list reads only the fields named above.
  return { controller, bottomBarHeight: 0 } as unknown as Parameters<typeof HostWorkspaceList>[0]
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

afterEach(unmountRenderers)
