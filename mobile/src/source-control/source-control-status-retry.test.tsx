import { createElement, type ComponentProps, type ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import { createFakeRpcClient, rpcSuccess } from '../mobile-web-shell/bridge-host-test-fakes'
import { createStableLogicalRpcClient } from '../transport/stable-logical-rpc-client'
import type { MobilePrTab } from '../components/pr-sidebar/use-mobile-pr-tab'
import type { MessageBox } from '../components/composer-input/MessageBox'
import type { TextField } from '../components/composer-input/TextField'
import type { FieldTextInput } from '../components/composer-input/FieldTextInput'
import type { SheetHeader } from '../components/nav-bar/SheetHeader'
import type { PRCheckDetail } from '../../../src/shared/github/check-types'

const doubles = vi.hoisted(
  (): {
    forceReconnect: ((hostId: string) => Promise<void>) | null
    client: RpcClient | null
    ignoreError: () => void
    // The real PR tab, as its ⋯ menu hook last received it; the menu's items call these same openers.
    tab: MobilePrTab | null
    // The mounted drawer's hide callback: the native close animation finishes only when the test says so.
    hide: (() => void) | null
    updateState: (state: string, prRepo: unknown) => void
  } => ({
    forceReconnect: null,
    client: null,
    ignoreError: () => {},
    tab: null,
    hide: null,
    updateState: () => {}
  })
)

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: 'Text',
  View: 'View'
}))
vi.mock('react-native-safe-area-context', () => ({
  SafeAreaView: 'SafeAreaView',
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 })
}))
// Modules in the mounted tree read icons at import time; render each one as nothing.
vi.mock('lucide-react-native', () =>
  Object.fromEntries(
    [
      'ArrowDown',
      'ArrowDownUp',
      'ArrowRight',
      'ArrowUp',
      'Bot',
      'Check',
      'ChevronDown',
      'ChevronLeft',
      'ChevronRight',
      'ChevronsUpDown',
      'CircleAlert',
      'CircleCheck',
      'CircleDashed',
      'CircleDot',
      'CircleMinus',
      'CircleX',
      'CloudUpload',
      'GitBranch',
      'GitMerge',
      'GitPullRequest',
      'GitPullRequestArrow',
      'History',
      'Link2',
      'ListFilter',
      'LoaderCircle',
      'MessageCircle',
      'MoreHorizontal',
      'RefreshCw',
      'RotateCw',
      'Search',
      'SearchX',
      'Sparkles',
      'WifiOff',
      'X'
    ].map((name) => [name, 'Icon'])
  )
)
// Thin native adapters: the real composer, sheet search and editor own their state; these forward it.
vi.mock('../components/composer-input/MessageBox', async () => {
  const { createElement: element } = await import('react')
  return { MessageBox: (props: ComponentProps<typeof MessageBox>) => element('MessageBox', props) }
})
vi.mock('../components/composer-input/TextField', async () => {
  const { createElement: element } = await import('react')
  return { TextField: (props: ComponentProps<typeof TextField>) => element('TextField', props) }
})
vi.mock('../components/composer-input/FieldTextInput', async () => {
  const { createElement: element } = await import('react')
  return {
    FieldTextInput: (props: ComponentProps<typeof FieldTextInput>) =>
      element('FieldTextInput', props)
  }
})
vi.mock('../components/nav-bar/SheetHeader', async () => {
  const { createElement: element } = await import('react')
  return {
    SheetHeader: (props: ComponentProps<typeof SheetHeader>) => element('SheetHeader', props)
  }
})
vi.mock('../components/list/ListGroup', async () => {
  const { createElement: element } = await import('react')
  return {
    LIST_LEADING_INSET: 0,
    ListGroup: ({ children }: { children: ReactNode }) => element('ListGroup', null, children),
    ListRow: (props: { title: string; detail?: ReactNode; accessory?: ReactNode }) =>
      element('ListRow', props, props.detail, props.accessory),
    SectionHeader: () => null
  }
})
// The native sheet keeps an outgoing presentation mounted until its close animation reports hidden.
vi.mock('../components/bottom-drawer/mounted-bottom-drawer', async () => {
  const { createElement: element } = await import('react')
  return {
    MountedBottomDrawer: (props: {
      visible: boolean
      onHidden: () => void
      children: ReactNode
    }) => {
      doubles.hide = props.onHidden
      return element('BottomDrawer', { visible: props.visible }, props.children)
    }
  }
})
// The hub pager keeps the overview mounted under a pushed page, as the native pager does.
vi.mock('../components/bottom-drawer/BottomDrawer', async () => {
  const { createElement: element, Fragment, useState } = await import('react')
  return {
    useOptionPager: () => {
      const [page, setPage] = useState<string | null>(null)
      return { page, open: setPage, close: () => setPage(null), forget: () => setPage(null) }
    },
    OptionPager: ({ main, page }: { main: ReactNode; page: ReactNode }) =>
      element(Fragment, null, main, page),
    BottomDrawer: ({ visible, children }: { visible: boolean; children: ReactNode }) =>
      visible ? element('ConfirmDrawer', null, children) : null
  }
})
vi.mock('../components/AutoHeight', () => ({
  AutoHeight: ({ children }: { children: ReactNode }) => children
}))
vi.mock('../components/MobileMarkdown', async () => {
  const { createElement: element } = await import('react')
  return {
    MobileMarkdown: ({ content }: { content: string }) => element('MobileMarkdown', { content })
  }
})
vi.mock('../components/nav-bar/NavBar', () => ({ NavBar: () => null }))
vi.mock('../components/nav-bar/NavBarButton', () => ({ NavBarButton: () => null }))
vi.mock('../components/nav-bar/PullDownMenu', () => ({ PullDownMenu: () => null }))
vi.mock('../components/MobileSegmentedControl', () => ({ MobileSegmentedControl: () => null }))
vi.mock('../components/AgentLaunchNotice', () => ({ AgentLaunchNotice: () => null }))
vi.mock('../components/pr-sidebar/PrThreadRow', () => ({ PrThreadRow: () => null }))
vi.mock('../components/pr-sidebar/PrThreadScreen', () => ({ PrThreadScreen: () => null }))
vi.mock('../components/pr-sidebar/PrChecksScreen', () => ({ PrChecksScreen: () => null }))
vi.mock('../components/pr-sidebar/PrCreateSheet', () => ({ PrCreateSheet: () => null }))
vi.mock('../components/pr-sidebar/PrTabEmptyState', () => ({ PrTabEmptyState: () => null }))
vi.mock('../components/pr-sidebar/PrTabBottomAction', () => ({ PrTabBottomAction: () => null }))
vi.mock('../components/pr-sidebar/use-pr-tab-menu', () => ({
  usePrTabMenuGroups: (tab: MobilePrTab) => {
    doubles.tab = tab
    return null
  }
}))
vi.mock('../platform/haptics', () => ({
  triggerError: () => {},
  triggerSelection: () => {},
  triggerSuccess: () => {}
}))
vi.mock('../platform/keyboard-occlusion', () => ({ useKeyboardOcclusion: () => 0 }))
vi.mock('../hooks/use-now', () => ({ useNow: () => 0, useAppActive: () => true }))
vi.mock('../session/use-mobile-launch-agent-label', () => ({
  useMobileLaunchAgentLabel: () => null
}))
vi.mock('../session/use-mobile-pr-actions', () => ({
  useMobilePrActions: ({ prRepo }: { prRepo: unknown }) => ({
    blocked: null,
    error: null,
    resolveReviewerRequested: (_login: string, value: boolean) => value,
    resolveState: (state: string) => state,
    resolveAutoMerge: (value: boolean) => value,
    isBusy: () => false,
    requestReviewer: () => {},
    removeReviewer: () => {},
    // A close or reopen would write for the PR this engine was rendered for.
    updateState: (state: string) => doubles.updateState(state, prRepo)
  })
}))
vi.mock('../session/use-mobile-pr-comment-actions', () => ({
  useMobilePrCommentActions: () => ({
    error: null,
    isRootBusy: false,
    addRootComment: async () => false,
    reply: async () => false,
    toggleResolve: () => {},
    editComment: async () => false,
    deleteComment: () => {},
    isReplyBusy: () => false,
    isResolveBusy: () => false,
    isEditBusy: () => false,
    isDeleteBusy: () => false
  })
}))
vi.mock('../session/use-mobile-pr-ai-triage', () => ({
  useMobilePrAiTriage: () => ({
    isBusy: () => false,
    noticeFor: () => ({}),
    availability: 'ready',
    launch: () => {}
  })
}))
vi.mock('../components/host-protocol-gates-context', () => ({
  useHostProtocolGates: () => ({ hostCapabilities: [], statusPending: false, statusReadable: true })
}))
vi.mock('../session/use-pr-bot-author-overrides', () => ({
  usePRBotAuthorOverrides: () => new Set()
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
vi.mock('../components/mobile-pr-url', () => ({ openMobilePrUrl: () => {} }))
// The header's verdict inputs come from the host store, which this panel-only scenario does not mount.
vi.mock('../transport/client-context-connection-metrics', () => ({
  useHostConnectionInputs: () => ({
    reconnectAttempts: 0,
    lastConnectedAt: null,
    pendingPath: null,
    pairingRejected: false,
    relayHostReachability: 'connecting'
  })
}))
vi.mock('./use-mobile-source-control-action-sheet', () => ({
  useMobileSourceControlActionSheet: () => []
}))
vi.mock('expo-router', async () => {
  const { useEffect } = await import('react')
  return { useFocusEffect: (effect: () => void) => useEffect(effect, [effect]) }
})
// The page has no forceReconnect; native providers supply it to redial after failed reads.
vi.mock('./use-mobile-source-control-state', async () => {
  const { useMobileSourceControlLoaders } = await import('./use-mobile-source-control-loaders')
  return {
    useMobileSourceControlState: ({
      hostId,
      worktreeId
    }: {
      hostId: string
      worktreeId: string
    }) => {
      const connState = doubles.client ? 'connected' : 'reconnecting'
      const loaders = useMobileSourceControlLoaders({
        client: doubles.client,
        connState,
        worktreeId,
        statusIdentityKey: `${hostId}\0${worktreeId}`,
        setActionError: doubles.ignoreError
      })
      const status = loaders.screenState.kind === 'ready' ? loaders.screenState.status : null
      return {
        client: doubles.client,
        connState,
        forceReconnect: doubles.forceReconnect,
        insets: { top: 0, bottom: 0, left: 0, right: 0 },
        router: { back: () => {} },
        setRootRef: () => {},
        worktreeLabel: 'wt',
        screenState: doubles.client
          ? loaders.screenState
          : { kind: 'error', message: 'Waiting for desktop...' },
        busyAction: null,
        loadStatus: loaders.loadStatus,
        status,
        branchCompareResult: null,
        branchLabel: '',
        unstagedCount: 0,
        stagedCount: 0,
        branchEntries: [],
        commitMessage: '',
        setCommitMessage: () => {},
        setCreatedPrUrl: () => {},
        setCreatedPrWarning: () => {},
        cancelGenerateCommitMessage: () => {},
        keyboardLift: 0,
        openDiffForFile: () => {},
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
      }
    }
  }
})

import { MobileSourceControlPanel } from './MobileSourceControlPanel'

let tree: ReactTestRenderer | null = null

afterEach(() => {
  act(() => tree?.unmount())
  tree = null
  doubles.client = null
  doubles.tab = null
  doubles.hide = null
  doubles.updateState = () => {}
})

type Held = { resolve: (reply: RpcResponse) => void; reject: (error: Error) => void }
const repository = (owner: string) => ({ owner, repo: 'widgets', host: 'github.corp' })
const pullRequest = (owner: string) => ({
  number: 93,
  state: 'open',
  title: owner,
  url: `https://github.corp/${owner}/widgets/pull/93`,
  prRepo: repository(owner),
  headSha: 'pr-head'
})

// The production hub with a real host connection: status, chip and PR reads go through the real loaders and
// controller, and the PR tab, its sheets and Comments are the real ones over thin native adapters.
function mountHub() {
  const physical = createFakeRpcClient()
  const client = createStableLogicalRpcClient(physical, 'relay')
  doubles.client = client
  const requests: { method: string; params: unknown }[] = []
  const held = new Map<string, Held[]>()
  const holding = new Set<string>()
  const io: {
    owner: string | null
    detailsBody: string
    checks: unknown[]
    switched: boolean
    pendingProbes: ((reply: RpcResponse) => void)[]
    pendingStatuses: ((reply: RpcResponse) => void)[]
  } = {
    owner: 'fork',
    detailsBody: 'body',
    checks: [],
    switched: false,
    pendingProbes: [],
    pendingStatuses: []
  }
  const status = (branch: string) => ({ entries: [], branch, head: `${branch}-head` })
  const reply = (method: string, params: unknown): unknown => {
    const owner = io.owner ?? 'fork'
    switch (method) {
      case 'github.repoSlug':
        return repository('fork')
      case 'git.status':
        return status('old-branch')
      case 'repo.list':
        return { repos: [] }
      case 'repo.baseRefDefault':
        return { defaultBaseRef: null }
      case 'settings.get':
        return { settings: {} }
      case 'worktree.show':
        return { worktree: { branch: io.switched ? 'new-branch' : 'old-branch' } }
      case 'hostedReview.forBranch':
        return null
      case 'github.prForBranch':
        return io.owner ? pullRequest(io.owner) : null
      case 'github.prChecks':
        return io.checks
      case 'status.get':
        return {
          runtimeId: 'a',
          hostDescriptor: { installationId: 'a' },
          capabilities: ['github.exact-work-item-target.v1']
        }
      case 'github.workItemDetails':
        return {
          item: {
            ...pullRequest(owner),
            id: `PR_${owner}`,
            type: 'pr',
            labels: [],
            updatedAt: '',
            author: null
          },
          body: io.detailsBody,
          comments: []
        }
      case 'github.listAssignableUsers':
        return [{ login: 'fork-only', name: null, avatarUrl: '' }]
      case 'github.updatePRTitle':
        return true
      case 'github.prCheckDetails':
        return { name: 'ci', title: JSON.stringify(params).includes('upstream') ? 'B' : 'A' }
      default:
        throw new Error(`unexpected ${method}`)
    }
  }
  physical.sendRequest = async (method, params) => {
    requests.push({ method, params })
    if (holding.has(method)) {
      return new Promise((resolve, reject) => {
        const queue = held.get(method) ?? []
        queue.push({ resolve, reject })
        held.set(method, queue)
      })
    }
    if (io.switched && method === 'github.repoSlug') {
      return new Promise((resolve) => io.pendingProbes.push(resolve))
    }
    if (io.switched && method === 'git.status') {
      return new Promise((resolve) => io.pendingStatuses.push(resolve))
    }
    return rpcSuccess(method, reply(method, params))
  }
  const queue = (method: string) => held.get(method) ?? []
  const resolveHeld = (method: string, value?: unknown) =>
    act(async () => {
      const next = queue(method).shift()!
      next.resolve(rpcSuccess(method, value ?? reply(method, {})))
    })
  const rejectHeld = (method: string) =>
    act(async () => queue(method).shift()!.reject(new Error('socket closed')))
  const count = (method: string) => requests.filter((r) => r.method === method).length
  const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
  const tab = () => doubles.tab!
  const rows = (title: string) =>
    tree!.root.findAll((node) => String(node.type) === 'ListRow' && node.props.title === title)
  const hasText = (value: string) =>
    tree!.root.findAll((node) => String(node.type) === 'Text' && node.props.children === value)
      .length > 0
  const composer = () => tree!.root.find((node) => String(node.type) === 'MessageBox')
  const search = () =>
    tree!.root.find(
      (node) => String(node.type) === 'TextField' && node.props.placeholder === 'Add a reviewer'
    )
  const editor = () => tree!.root.findAll((node) => String(node.type) === 'FieldTextInput')
  const header = (title: string) =>
    tree!.root.find((node) => String(node.type) === 'SheetHeader' && node.props.title === title)
  const drawer = () => tree!.root.findAll((node) => String(node.type) === 'BottomDrawer')[0]
  const refreshLine = () =>
    tree!.root.findAll(
      (node) =>
        String(node.type) === 'Text' && node.props.children === 'Failed to refresh pull request.'
    )
  const press = (label: string) =>
    act(async () =>
      tree!.root
        .find(
          (node) => String(node.type) === 'Pressable' && node.props.accessibilityLabel === label
        )
        .props.onPress()
    )
  const call = (run: () => unknown) => act(async () => void run())
  // The native close animation finishing, after which the drawer may present another sheet.
  const finishHide = () => act(async () => doubles.hide?.())
  const renderPanel = (worktreeId: string, initialTab?: 'pr') =>
    act(async () => {
      const element = createElement(MobileSourceControlPanel, {
        hostId: 'host-a',
        worktreeId,
        ...(initialTab ? { initialTab } : {})
      })
      if (tree) {
        tree.update(element)
      } else {
        tree = create(element)
      }
    })
  const migrate = async () => {
    const next = createFakeRpcClient()
    next.sendRequest = physical.sendRequest
    await act(async () => client.migrateTo(next, 'lan'))
  }
  return {
    io,
    requests,
    holding,
    queue,
    resolveHeld,
    rejectHeld,
    count,
    settle,
    tab,
    rows,
    hasText,
    composer,
    search,
    editor,
    header,
    drawer,
    refreshLine,
    press,
    call,
    finishHide,
    renderPanel,
    migrate
  }
}

it('reuses Source Control across worktrees without loading the old fallback, continues chip and PR demand, and keeps the reviewers sheet and the Comments draft through connection replacement and failed refreshes', async () => {
  const hub = mountHub()
  const { io, requests, holding, count, settle, rows, search, composer, refreshLine } = hub
  await hub.renderPanel('wt-1')
  expect(count('github.prForBranch')).toBe(1)
  expect(count('github.workItemDetails')).toBe(0)
  const beforeSwitch = requests.length
  io.switched = true
  await hub.renderPanel('wt-2')
  const readMethods = new Set([
    'worktree.show',
    'hostedReview.forBranch',
    'github.prForBranch',
    'github.prChecks',
    'github.workItemDetails'
  ])
  expect(requests.slice(beforeSwitch).filter((r) => readMethods.has(r.method))).toEqual([])
  expect(io.pendingProbes).toHaveLength(1)
  expect(io.pendingStatuses).toHaveLength(1)
  await act(async () => io.pendingProbes.shift()!(rpcSuccess('probe-w2', repository('fork'))))
  expect(requests.slice(beforeSwitch).filter((r) => readMethods.has(r.method))).toEqual([])
  await act(async () =>
    io.pendingStatuses.shift()!(
      rpcSuccess('status-w2', { entries: [], branch: 'new-branch', head: 'new-branch-head' })
    )
  )
  const prReads = requests.filter((r) => r.method === 'github.prForBranch')
  expect(prReads).toHaveLength(2)
  expect(prReads[1].params).toMatchObject({
    repo: 'id:wt-2',
    branch: 'new-branch',
    currentHeadOid: 'new-branch-head'
  })
  const afterSwitch = requests
    .slice(beforeSwitch)
    .filter((r) => r.method === 'hostedReview.forBranch')
  expect(afterSwitch).toHaveLength(1)
  expect(afterSwitch[0].params).toMatchObject({ repo: 'id:wt-2', branch: 'new-branch' })
  expect(count('github.workItemDetails')).toBe(0)
  // Reaching the PR tab is what asks for details.
  await hub.renderPanel('wt-2', 'pr')
  await settle()
  expect(count('github.workItemDetails')).toBe(1)

  // Reviewers phase: the approvals gate opens the real sheet, and a first search loads the fork's people.
  await hub.call(() => rows('No approvals yet')[0].props.onPress())
  await hub.call(() => search().props.onChangeText('fork'))
  await settle()
  expect(rows('fork-only')).toHaveLength(1)
  holding.add('github.prForBranch')
  holding.add('github.listAssignableUsers')
  await hub.call(() => hub.tab().refetch({ includeDetails: true }))
  await settle()
  expect(hub.queue('github.prForBranch')).toHaveLength(1)
  const prReadsBefore = count('github.prForBranch')
  const detailReads = count('github.workItemDetails')

  // A connected-to-connected replacement, then an ordinary parent render with the same branch and PR.
  await hub.migrate()
  await hub.renderPanel('wt-2', 'pr')
  expect(search().props.value).toBe('fork')
  expect(rows('fork-only')).toHaveLength(1)
  expect(hub.drawer().props.visible).toBe(true)
  expect(hub.hasText('Loading pull request…')).toBe(false)
  // The connection event alone started one successor while the retired read is still unresolved.
  await settle()
  expect(count('github.prForBranch')).toBe(prReadsBefore + 1)
  expect(hub.queue('github.prForBranch')).toHaveLength(2)
  expect(hub.queue('github.listAssignableUsers')).toHaveLength(1)
  await hub.resolveHeld('github.prForBranch', { ...pullRequest('fork'), title: 'retired' })
  await settle()
  expect(count('github.workItemDetails')).toBe(detailReads)
  await hub.resolveHeld('github.prForBranch')
  await settle()
  expect(count('github.workItemDetails')).toBe(detailReads + 1)
  await hub.resolveHeld('github.listAssignableUsers', [
    { login: 'fork-only', name: null, avatarUrl: '' },
    { login: 'fork-second', name: null, avatarUrl: '' }
  ])
  await settle()
  expect(rows('fork-second')).toHaveLength(1)
  expect(search().props.value).toBe('fork')

  // A current read failure keeps the PR and the open sheet and shows the existing refresh line with Retry.
  holding.add('github.workItemDetails')
  io.detailsBody = 'refreshed body'
  await hub.call(() => hub.tab().refetch({ includeDetails: true }))
  await settle()
  await hub.resolveHeld('github.prForBranch')
  await settle()
  expect(hub.queue('github.workItemDetails')).toHaveLength(1)
  await hub.call(() => hub.tab().refetch({ includeDetails: false }))
  await settle()
  await hub.rejectHeld('github.prForBranch')
  await settle()
  expect(refreshLine()).toHaveLength(1)
  expect(hub.hasText('Loading pull request…')).toBe(false)
  expect(hub.hasText('socket closed')).toBe(false)
  expect(search().props.value).toBe('fork')
  expect(rows('fork-second')).toHaveLength(1)
  // Details settling later cannot certify the PR read, so the line stays.
  holding.delete('github.workItemDetails')
  await hub.resolveHeld('github.workItemDetails')
  await settle()
  expect(tree!.root.find((node) => String(node.type) === 'MobileMarkdown').props.content).toBe(
    'refreshed body'
  )
  expect(refreshLine()).toHaveLength(1)
  // Retry keeps the line while pending; a current good read clears it in place.
  await hub.press('Retry loading pull request')
  await settle()
  expect(refreshLine()).toHaveLength(1)
  await hub.resolveHeld('github.prForBranch')
  await settle()
  expect(refreshLine()).toHaveLength(0)
  expect(search().props.value).toBe('fork')

  // A saved title's follow-up read failing marks the PR once; the save stays acknowledged and sent once.
  await hub.call(() => hub.header('Reviewers').props.trailing!.onPress())
  await hub.finishHide()
  await hub.call(() => hub.tab().openEditTitleSheet())
  await hub.call(() => hub.editor()[0].props.onChangeText!('Renamed'))
  await hub.call(() => hub.header('Edit title').props.trailing!.onPress())
  await settle()
  await hub.rejectHeld('github.prForBranch')
  await settle()
  expect(count('github.updatePRTitle')).toBe(1)
  expect(refreshLine()).toHaveLength(1)
  expect(hub.hasText('socket closed')).toBe(false)
  expect(hub.hasText('Failed to update title.')).toBe(false)
  expect(hub.drawer().props.visible).toBe(false)
  await hub.finishHide()
  await hub.press('Retry loading pull request')
  await settle()
  await hub.resolveHeld('github.prForBranch')
  await settle()
  expect(refreshLine()).toHaveLength(0)

  // Comments phase: the real composer's unsent draft survives a replacement and a failed refresh in place.
  await hub.call(() => hub.tab().openCommentsScreen())
  await settle()
  await hub.call(() => composer().props.onChangeText('unsent draft'))
  await hub.call(() => hub.tab().refetch({ includeDetails: true }))
  await settle()
  await hub.migrate()
  await hub.renderPanel('wt-2', 'pr')
  expect(composer().props.value).toBe('unsent draft')
  await settle()
  expect(hub.queue('github.prForBranch')).toHaveLength(2)
  await hub.resolveHeld('github.prForBranch', { ...pullRequest('fork'), title: 'retired' })
  await settle()
  expect(composer().props.value).toBe('unsent draft')
  await hub.resolveHeld('github.prForBranch')
  await settle()
  expect(composer().props.value).toBe('unsent draft')
  await hub.call(() => hub.tab().refetch({ includeDetails: false }))
  await settle()
  await hub.rejectHeld('github.prForBranch')
  await settle()
  expect(refreshLine()).toHaveLength(1)
  expect(hub.hasText('socket closed')).toBe(false)
  expect(composer().props.value).toBe('unsent draft')

  // An accepted no-PR result is retained and marked the same way.
  io.owner = null
  await hub.call(() => hub.tab().refetch({ includeDetails: false }))
  await settle()
  await hub.resolveHeld('github.prForBranch', null)
  await settle()
  expect(refreshLine()).toHaveLength(0)
  await hub.call(() => hub.tab().refetch({ includeDetails: false }))
  await settle()
  await hub.rejectHeld('github.prForBranch')
  await settle()
  expect(refreshLine()).toHaveLength(1)
  expect(hub.hasText('socket closed')).toBe(false)
})

it('closes a fork sheet and confirmation when upstream #N with the same number arrives, sends nothing for them, and fences a held fork action and check read across A, B and A again', async () => {
  const hub = mountHub()
  const { io, settle, count, editor } = hub
  const writes: unknown[] = []
  doubles.updateState = (state, prRepo) => writes.push({ state, prRepo })
  await hub.renderPanel('wt-1', 'pr')
  await settle()
  await settle()
  const select = async (owner: string) => {
    io.owner = owner
    await hub.call(() => hub.tab().refetch({ includeDetails: true }))
    await settle()
  }

  // A fork edit with a draft and an open close confirmation, then upstream with the same number and branch.
  await hub.call(() => hub.tab().openEditTitleSheet())
  await hub.call(() => editor()[0].props.onChangeText!('fork draft'))
  const staleSave = hub.header('Edit title').props.trailing!.onPress
  await hub.call(() => hub.tab().setConfirm('close'))
  const staleConfirm = hub.tab().runConfirm
  expect(tree!.root.findAll((node) => String(node.type) === 'ConfirmDrawer')).toHaveLength(1)
  await select('upstream')
  // The outgoing presentation is still animating, but renders nothing of the fork and admits no action.
  expect(hub.drawer().props.visible).toBe(false)
  expect(editor()).toHaveLength(0)
  expect(tree!.root.findAll((node) => String(node.type) === 'ConfirmDrawer')).toHaveLength(0)
  await hub.call(staleSave)
  await hub.call(staleConfirm)
  await settle()
  expect(count('github.updatePRTitle')).toBe(0)
  expect(writes).toEqual([])
  await hub.finishHide()
  await hub.call(() => hub.tab().openEditTitleSheet())
  expect(editor()[0].props.value).toBe('upstream')
  await hub.call(() => hub.tab().closeSheet())
  await hub.finishHide()

  // A current fork save goes to the fork only; landing after upstream arrived, it cannot close upstream's sheet.
  await select('fork')
  await hub.call(() => hub.tab().openEditTitleSheet())
  await hub.call(() => editor()[0].props.onChangeText!('fork renamed'))
  hub.holding.add('github.updatePRTitle')
  await hub.call(() => hub.header('Edit title').props.trailing!.onPress())
  await settle()
  const titleWrites = hub.requests.filter((r) => r.method === 'github.updatePRTitle')
  expect(titleWrites).toHaveLength(1)
  expect(JSON.stringify(titleWrites[0].params)).toContain('"fork"')
  expect(JSON.stringify(titleWrites[0].params)).not.toContain('upstream')
  await select('upstream')
  await hub.finishHide()
  await hub.call(() => hub.tab().openEditTitleSheet())
  await hub.resolveHeld('github.updatePRTitle', true)
  await settle()
  expect(hub.drawer().props.visible).toBe(true)
  expect(editor()[0].props.value).toBe('upstream')
  await hub.call(() => hub.tab().closeSheet())
  await hub.finishHide()
  // A current confirmation still acts, for the PR it opened for.
  await hub.call(() => hub.tab().setConfirm('close'))
  await hub.call(() => hub.tab().runConfirm())
  expect(writes).toMatchObject([{ state: 'closed', prRepo: { owner: 'upstream' } }])

  // A held fork check read cannot fill upstream's cache or the fork's next incarnation; each asks for its own.
  const check: PRCheckDetail = {
    name: 'ci',
    status: 'completed',
    conclusion: 'failure',
    url: null,
    checkRunId: 7
  }
  await select('fork')
  hub.holding.add('github.prCheckDetails')
  await hub.call(() => hub.tab().ensureCheckDetail(check))
  expect(hub.queue('github.prCheckDetails')).toHaveLength(1)
  await select('upstream')
  expect(hub.tab().checkDetails).toEqual({})
  await select('fork')
  await hub.resolveHeld('github.prCheckDetails')
  await settle()
  expect(hub.tab().checkDetails).toEqual({})
  await hub.call(() => hub.tab().ensureCheckDetail(check))
  expect(hub.queue('github.prCheckDetails')).toHaveLength(1)
  hub.holding.delete('github.prCheckDetails')
  await hub.resolveHeld('github.prCheckDetails')
  await settle()
  expect(hub.tab().checkDetails['run:7']).toMatchObject({ status: 'loaded' })
  // Same-resource refresh and connection replacement keep the eligible cache and an open sheet.
  await hub.call(() => hub.tab().openEditTitleSheet())
  await select('fork')
  await hub.migrate()
  await settle()
  expect(hub.tab().checkDetails['run:7']).toMatchObject({ status: 'loaded' })
  expect(hub.drawer().props.visible).toBe(true)
  expect(editor()).toHaveLength(1)
})
