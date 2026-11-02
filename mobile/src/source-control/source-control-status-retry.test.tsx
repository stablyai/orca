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
vi.mock('lucide-react-native', () => ({
  CircleAlert: 'Icon',
  GitBranch: 'Icon',
  RefreshCw: 'Icon',
  WifiOff: 'Icon'
}))
vi.mock('./MobileSourceControlHeader', () => ({ MobileSourceControlHeader: () => null }))
vi.mock('./MobileSourceControlContent', () => ({ MobileSourceControlContent: () => null }))
vi.mock('./MobileSourceControlModals', () => ({ MobileSourceControlModals: () => null }))
vi.mock('./MobileSourceControlBranchCard', () => ({ MobileSourceControlBranchCard: () => null }))
vi.mock('./MobileSourceControlHubCommitsPage', () => ({
  MobileSourceControlHubCommitsPage: () => null
}))
vi.mock('./MobileSourceControlNextStepBar', () => ({ MobileSourceControlNextStepBar: () => null }))
vi.mock('./use-mobile-source-control-next-step', () => ({
  useMobileSourceControlNextStep: () => ({
    view: { kind: 'hidden' },
    notice: null,
    agentNotice: null,
    mergeConfirm: null
  })
}))
vi.mock('../navigation/use-back-claim', () => ({ useBackClaim: () => {} }))
vi.mock('../components/BottomDrawer', () => ({
  useOptionPager: () => ({ page: null, open: () => {}, close: () => {}, forget: () => {} }),
  OptionPager: ({ main }: { main: unknown }) => main
}))
vi.mock('../components/mobile-pr-url', () => ({ openMobilePrUrl: () => {} }))
vi.mock('../components/MobilePRSidebar', () => ({ MobilePrTabBody: () => null }))
vi.mock('../components/pr-sidebar/MobilePrTabSheets', () => ({ MobilePrTabSheets: () => null }))
vi.mock('../components/pr-sidebar/PrChecksScreen', () => ({ PrChecksScreen: () => null }))
vi.mock('../components/pr-sidebar/PrCommentsScreen', () => ({ PrCommentsScreen: () => null }))
vi.mock('../components/pr-sidebar/use-mobile-pr-tab', () => ({
  useMobilePrTab: () => ({ openCreatePrSheet: () => {} })
}))
vi.mock('../components/pr-sidebar/use-pr-tab-menu', () => ({ usePrTabMenuGroups: () => null }))
vi.mock('../navigation/use-back-claim', () => ({ useBackClaim: () => {} }))
vi.mock('./use-mobile-source-control-action-sheet', () => ({
  useMobileSourceControlActionSheet: () => []
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
// The page has no forceReconnect; native providers supply it to redial after failed reads.
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
    loadStatus: doubles.loadStatus,
    status: null,
    branchCompareResult: null,
    branchLabel: '',
    unstagedCount: 0,
    stagedCount: 0,
    branchEntries: [],
    abortConflictOperation: () => Promise.resolve(),
    resolveConflict: () => Promise.resolve(),
    completeMerge: () => Promise.resolve(),
    primaryActionArgs: {
      status: null,
      hasUnresolvedConflicts: false,
      stageablePaths: [],
      stagedCount: 0,
      unstagedCount: 0,
      commitMessage: '',
      busyAction: null,
      branchCompareResult: null,
      handlers: {}
    }
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
        .some((text) => text.props.children === 'Reconnect')
    )
}

describe("source control's status Retry while the host is unreachable", () => {
  it('is absent on the page, where nothing can re-dial', () => {
    doubles.forceReconnect = null
    const rendered = render()
    expect(
      rendered.root.findAll((node) => node.props.children === 'Waiting for desktop')
    ).not.toHaveLength(0)
    expect(retryControls(rendered)).toHaveLength(0)
  })

  it('offers Retry when a reconnect callback is available and dispatches this host', () => {
    const forceReconnect = vi.fn(() => Promise.resolve())
    doubles.forceReconnect = forceReconnect
    const [retry] = retryControls(render())
    act(() => {
      retry?.props.onPress()
    })
    expect(forceReconnect.mock.calls).toEqual([['host-a']])
  })
})
