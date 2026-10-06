import { createElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

const doubles = vi.hoisted(
  (): {
    forceReconnect: ((hostId: string) => Promise<void>) | null
    loadStatus: () => Promise<void>
  } => ({ forceReconnect: null, loadStatus: () => Promise.resolve() })
)

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Pressable: 'Pressable',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: 'Text',
  View: 'View'
}))
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'SafeAreaView' }))
// The panel's collaborators, each rendering nothing: what is under test is its own status gate.
vi.mock('./MobileSourceControlHeader', () => ({ MobileSourceControlHeader: () => null }))
vi.mock('./MobileSourceControlContent', () => ({ MobileSourceControlContent: () => null }))
vi.mock('./MobileSourceControlModals', () => ({ MobileSourceControlModals: () => null }))
vi.mock('./MobileSourceControlSegments', () => ({ MobileSourceControlSegments: () => null }))
vi.mock('./MobileSourceControlBranchCard', () => ({ MobileSourceControlBranchCard: () => null }))
vi.mock('./MobileGitHistoryList', () => ({ MobileGitHistoryList: () => null }))
vi.mock('../components/pr-sidebar/MobilePrViewPanel', () => ({ MobilePrViewPanelBody: () => null }))
vi.mock('../components/mobile-pr-url', () => ({ openMobilePrUrl: () => {} }))
vi.mock('./use-mobile-source-control-action-sheet', () => ({
  useMobileSourceControlActionSheet: () => ({})
}))
vi.mock('../session/use-mobile-pr-sidebar-controller', () => ({
  useMobilePrSidebarController: () => ({
    prSidebarIsGithubRepo: false,
    prSidebarState: { kind: 'hidden' },
    prSidebarRepoProbeLoaded: false,
    refetchPRSidebar: () => Promise.resolve(),
    ensurePrSidebarDetails: () => Promise.resolve()
  })
}))
// A status read that failed while the host was unreachable, with `forceReconnect` as the provider
// hands it out: null on the page, a re-dial natively.
vi.mock('./use-mobile-source-control-state', () => ({
  useMobileSourceControlState: () => ({
    client: null,
    connState: 'reconnecting',
    forceReconnect: doubles.forceReconnect,
    insets: { top: 0, bottom: 0, left: 0, right: 0 },
    router: { back: () => {} },
    setRootRef: () => {},
    worktreeLabel: 'wt',
    screenState: { kind: 'error', message: 'Waiting for desktop...' },
    busyAction: null,
    openingPath: null,
    openingBranchPath: null,
    loadStatus: doubles.loadStatus,
    status: null,
    branchCompareResult: null,
    branchLabel: '',
    syncLabel: '',
    unstagedCount: 0,
    stagedCount: 0,
    branchEntries: [],
    abortConflictOperation: () => Promise.resolve()
  })
}))

import { MobileSourceControlPanel } from './MobileSourceControlPanel'

let tree: ReactTestRenderer | null = null

afterEach(() => {
  act(() => tree?.unmount())
  tree = null
})

function render(): ReactTestRenderer {
  act(() => {
    tree = create(createElement(MobileSourceControlPanel, { hostId: 'host-a', worktreeId: 'wt-1' }))
  })
  if (tree === null) {
    throw new Error('the panel did not render')
  }
  return tree
}

function retryControls(rendered: ReactTestRenderer): ReactTestInstance[] {
  return rendered.root
    .findAll((node) => String(node.type) === 'Pressable')
    .filter((node) =>
      node
        .findAll((text) => String(text.type) === 'Text')
        .some((text) => text.props.children === 'Retry')
    )
}

describe("source control's status Retry while the host is unreachable", () => {
  it('is absent on the page, where nothing can re-dial', () => {
    doubles.forceReconnect = null
    const rendered = render()
    expect(
      rendered.root.findAll((node) => node.props.children === 'Waiting for desktop...')
    ).not.toHaveLength(0)
    expect(retryControls(rendered)).toHaveLength(0)
  })

  it('still renders natively and re-dials this host', () => {
    const forceReconnect = vi.fn(() => Promise.resolve())
    doubles.forceReconnect = forceReconnect
    const [retry] = retryControls(render())
    act(() => {
      retry?.props.onPress()
    })
    expect(forceReconnect.mock.calls).toEqual([['host-a']])
  })
})
