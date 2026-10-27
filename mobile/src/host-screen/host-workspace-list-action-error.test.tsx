import { createElement, useState } from 'react'
import {
  act,
  create as createRenderer,
  type ReactTestInstance,
  type ReactTestRenderer
} from 'react-test-renderer'

import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('react-native', () => ({
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
vi.mock('../worktree/host-workspace-list-states', () => ({
  HostWorkspaceListStates: 'HostWorkspaceListStates'
}))

import { colors } from '../theme/mobile-theme'
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

// Render the real list banner: the screen suite mocks it away and cannot catch missing error copy or dismissal.
function listWith(fields: { actionError: string; setActionError: (value: string) => void }) {
  const rows = [{ worktreeId: 'wt-1', repo: 'orca' }]
  const sections = [{ key: 'all', title: '', data: rows }]
  const controller = {
    actions: { openWorktreeSession: () => {}, openNewWorktreeModal: () => {} },
    activeWorktreeScroll: { sectionListRef: { current: null }, onScrollToIndexFailed: () => {} },
    catalog: { refreshing: false, onRefresh: () => {} },
    connState: 'connected',
    contentMaxWidth: 600,
    displayWorktrees: rows,
    // Use the embedded path to avoid unrelated floating-button dependencies.
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
    sectionsResult: { rawSections: sections, sections, repoById: new Map() },
    setDismissedNotice: () => {},
    settings: { activeFilterCount: 0, pendingViewChanges: { pending: [], stale: false } },
    state: {
      actionError: fields.actionError,
      setActionError: fields.setActionError,
      catalogError: null,
      collapsedGroups: new Set(),
      view: { ...INITIAL_MOBILE_VIEW, groupBy: 'none' },
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
  function List(): ReturnType<typeof createElement> {
    const [actionError, setActionError] = useState(fields.actionError)
    return createElement(
      HostWorkspaceList,
      listWith({
        actionError,
        setActionError: (value) => {
          fields.setActionError(value)
          setActionError(value)
        }
      })
    )
  }
  const rendered: { tree: ReactTestRenderer | null } = { tree: null }
  act(() => {
    rendered.tree = create(createElement(List))
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
    const list = tree.root.find((node) => String(node.type) === 'SectionList')
    expect(list.props.sections[0].data).toEqual([{ worktreeId: 'wt-1', repo: 'orca' }])
    expect(tree.root.findAll((node) => node === banner || node === list)).toEqual([banner, list])
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
    expect(texts(tree)).not.toContain('Could not delete workspace.')
    expect(
      tree.root.find((node) => String(node.type) === 'SectionList').props.sections[0].data
    ).toEqual([{ worktreeId: 'wt-1', repo: 'orca' }])
  })

  it('paints nothing at all while there is none', () => {
    const tree = render({ actionError: '', setActionError: () => {} })
    expect(texts(tree)).toEqual([])
  })
})

afterEach(unmountRenderers)
