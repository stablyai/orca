import { createElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'

vi.mock('react-native', () => ({
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
vi.mock('../worktree/host-workspace-list-states', () => ({
  HostWorkspaceListStates: 'HostWorkspaceListStates'
}))

import { colors } from '../theme/mobile-theme'
import { HostWorkspaceList } from './host-workspace-list'

/**
 * The banner the list paints for an action that did not happen, rendered rather than described.
 *
 * The screen's own suite mocks this component away, so nothing there notices if the banner or its
 * dismiss stops being rendered — which is the entire user-visible surface of a failed action.
 */
function listWith(fields: { actionError: string; setActionError: (value: string) => void }) {
  const controller = {
    actions: { openWorktreeSession: () => {}, openNewWorktreeModal: () => {} },
    activeWorktreeScroll: { sectionListRef: { current: null }, onScrollToIndexFailed: () => {} },
    catalog: { refreshing: false, onRefresh: () => {} },
    connState: 'connected',
    contentMaxWidth: 600,
    displayWorktrees: [],
    // The sidebar shape, which is the one that renders no floating button: what this file is about
    // sits above the list, and the button is a child it would otherwise have to stand up too.
    embedded: true,
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
    sectionsResult: { rawSections: [], sections: [], uniqueRepoColors: new Map() },
    setDismissedNotice: () => {},
    settings: { activeFilterCount: 0 },
    state: {
      actionError: fields.actionError,
      setActionError: fields.setActionError,
      catalogError: null,
      collapsedGroups: new Set(),
      groupMode: 'none',
      repoIconsByName: new Map(),
      search: '',
      showSearch: false,
      worktreesLoaded: true
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every child below the banner is mocked to a host string here, so what the list reads off the controller is exactly the fields named above.
  return { controller } as unknown as Parameters<typeof HostWorkspaceList>[0]
}

function render(fields: {
  actionError: string
  setActionError: (value: string) => void
}): ReactTestRenderer {
  const rendered: { tree: ReactTestRenderer | null } = { tree: null }
  act(() => {
    rendered.tree = create(createElement(HostWorkspaceList, listWith(fields)))
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

function dismiss(tree: ReactTestRenderer): ReactTestInstance {
  const [only, ...rest] = tree.root.findAll(
    (node) =>
      String(node.type) === 'Pressable' && node.props.accessibilityLabel === 'Dismiss notice'
  )
  if (only === undefined || rest.length > 0) {
    throw new Error(`expected one dismiss, found ${rest.length + Number(only !== undefined)}`)
  }
  return only
}

describe('an action that did not happen', () => {
  it('is on screen above the list, in the tone that says it failed', () => {
    const tree = render({ actionError: 'Could not delete workspace.', setActionError: () => {} })
    expect(texts(tree)).toEqual(['Could not delete workspace.'])
    const banner = tree.root.findAll(
      (node) => String(node.type) === 'View' && Array.isArray(node.props.style)
    )[0]
    expect(banner?.props.style).toContainEqual({ borderBottomColor: colors.statusRed })
  })

  it('is dismissible, because the list and the confirm it re-opens have to stay reachable', () => {
    const cleared: string[] = []
    const tree = render({
      actionError: 'Could not delete workspace.',
      setActionError: (value) => cleared.push(value)
    })
    act(() => {
      dismiss(tree).props.onPress()
    })
    expect(cleared).toEqual([''])
  })

  it('paints nothing at all while there is none', () => {
    const tree = render({ actionError: '', setActionError: () => {} })
    expect(texts(tree)).toEqual([])
  })
})
