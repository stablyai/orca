import { createElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import { createFakeRpcClient, rpcSuccess } from '../mobile-web-shell/bridge-host-test-fakes'
import { createStableLogicalRpcClient } from '../transport/stable-logical-rpc-client'
import type { PrSidebarLoadOptions } from '../session/use-mobile-pr-sidebar-controller'

const doubles = vi.hoisted(
  (): {
    forceReconnect: ((hostId: string) => Promise<void>) | null
    client: RpcClient | null
    ignoreError: () => void
    // The real sidebar refetch, captured from the mocked PR actions hook it is handed to.
    refetchPr: ((options?: PrSidebarLoadOptions) => void) | null
  } => ({ forceReconnect: null, client: null, ignoreError: () => {}, refetchPr: null })
)

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
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
vi.mock('lucide-react-native', () => ({
  Check: () => null,
  ChevronDown: () => null,
  ChevronRight: () => null,
  RotateCw: () => null,
  Search: () => null,
  UserPlus: () => null,
  X: () => null
}))
// Thin native adapters: the real composer, picker and search own their state; these forward it.
vi.mock('../components/composer-input/MessageBox', async () => {
  const { createElement: element } = await import('react')
  return { MessageBox: (props: object) => element('MessageBox', props) }
})
vi.mock('../components/composer-input/TextField', async () => {
  const { createElement: element } = await import('react')
  return { TextField: (props: object) => element('TextField', props) }
})
vi.mock('../components/composer-input/composer-input-styles', () => ({ composerInputStyles: {} }))
vi.mock('../components/BottomDrawer', async () => {
  const { createElement: element } = await import('react')
  return {
    BottomDrawer: ({ visible, children }: { visible: boolean; children: unknown }) =>
      visible ? element('BottomDrawer', null, children) : null
  }
})
vi.mock('../components/pr-sidebar/CommentMarkdown', async () => {
  const { createElement: element } = await import('react')
  return {
    CommentMarkdown: ({ content }: { content: string }) => element('CommentMarkdown', { content })
  }
})
vi.mock('../components/pr-sidebar/PRCommentCard', () => ({ PRCommentCard: () => null }))
vi.mock('../components/pr-sidebar/PRSidebarHeader', () => ({ PRSidebarHeader: () => null }))
vi.mock('../components/pr-sidebar/PRActionsSection', () => ({ PRActionsSection: () => null }))
vi.mock('../components/pr-sidebar/PRConflictingFilesSection', () => ({
  PRConflictingFilesSection: () => null
}))
vi.mock('../components/pr-sidebar/PRChecksSection', () => ({ PRChecksSection: () => null }))
vi.mock('../components/pr-sidebar/PrSidebarCreateEmptyState', () => ({
  PrSidebarCreateEmptyState: () => null
}))
vi.mock('../session/use-mobile-pr-actions', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useMobilePrActions: ({ refetch }: { refetch: (options?: PrSidebarLoadOptions) => void }) => {
    doubles.refetchPr = refetch
    return {
      blocked: null,
      resolveReviewerRequested: (_login: string, value: boolean) => value,
      isBusy: () => false,
      requestReviewer: () => {},
      removeReviewer: () => {}
    }
  }
}))
vi.mock('../session/use-mobile-pr-comment-actions', async (importOriginal) => ({
  ...(await importOriginal<object>()),
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
vi.mock('../session/use-mobile-pr-title-action', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useMobilePrTitleAction: () => ({})
}))
vi.mock('../session/use-mobile-pr-ai-triage', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useMobilePrAiTriage: () => ({
    isBusy: () => false,
    noticeFor: () => ({}),
    availability: 'ready',
    launch: () => {}
  })
}))
vi.mock('../components/host-protocol-gates-context', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useHostProtocolGates: () => ({ hostCapabilities: [], statusPending: false, statusReadable: true })
}))
vi.mock('../session/use-pr-bot-author-overrides', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  usePRBotAuthorOverrides: () => new Set()
}))
vi.mock('./MobileSourceControlHeader', () => ({ MobileSourceControlHeader: () => null }))
vi.mock('./MobileSourceControlContent', () => ({ MobileSourceControlContent: () => null }))
vi.mock('./MobileSourceControlModals', () => ({ MobileSourceControlModals: () => null }))
vi.mock('./MobileSourceControlSegments', () => ({ MobileSourceControlSegments: () => null }))
vi.mock('./MobileSourceControlBranchCard', () => ({ MobileSourceControlBranchCard: () => null }))
vi.mock('./MobileGitHistoryList', () => ({ MobileGitHistoryList: () => null }))
vi.mock('../components/mobile-pr-url', () => ({ openMobilePrUrl: () => {} }))
vi.mock('./use-mobile-source-control-action-sheet', () => ({
  useMobileSourceControlActionSheet: () => ({})
}))
// The page has no forceReconnect; native providers supply it to redial after failed reads.
vi.mock('expo-router', async () => {
  const { useEffect } = await import('react')
  return { useFocusEffect: useEffect }
})
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
        screenState: loaders.screenState,
        busyAction: null,
        openingPath: null,
        openingBranchPath: null,
        loadStatus: loaders.loadStatus,
        status,
        branchCompareResult: null,
        branchLabel: '',
        syncLabel: '',
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
          openingPath: null,
          openingBranchPath: null,
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
  doubles.refetchPr = null
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

it('reuses Source Control across worktrees without loading the old fallback into the new worktree, then continues chip and PR demand and keeps the viewed PR through a connection replacement', async () => {
  const physical = createFakeRpcClient()
  const client = createStableLogicalRpcClient(physical, 'relay')
  doubles.client = client
  const requests: { method: string; params: unknown }[] = []
  type Held = { resolve: (reply: RpcResponse) => void; reject: (error: Error) => void }
  let holdPr = false
  let holdUsers = false
  const heldPr: Held[] = []
  const heldUsers: Held[] = []
  let detailsBody = 'body'
  const pendingProbes: ((reply: RpcResponse) => void)[] = []
  const pendingStatuses: ((reply: RpcResponse) => void)[] = []
  let switched = false
  const repository = { owner: 'fork', repo: 'widgets', host: 'github.corp' }
  const pullRequest = {
    number: 93,
    state: 'open',
    title: 'PR',
    url: 'https://github.corp/fork/widgets/pull/93',
    prRepo: repository,
    headSha: 'pr-head'
  }
  const status = (branch: string) => ({ entries: [], branch, head: `${branch}-head` })
  physical.sendRequest = async (method, params) => {
    requests.push({ method, params })
    if (
      (holdPr && method === 'github.prForBranch') ||
      (holdUsers && method === 'github.listAssignableUsers')
    ) {
      const held = method === 'github.prForBranch' ? heldPr : heldUsers
      return new Promise((resolve, reject) => held.push({ resolve, reject }))
    }
    if (switched && method === 'github.repoSlug') {
      return new Promise((resolve) => pendingProbes.push(resolve))
    }
    if (switched && method === 'git.status') {
      return new Promise((resolve) => pendingStatuses.push(resolve))
    }
    const value =
      method === 'github.repoSlug'
        ? repository
        : method === 'git.status'
          ? status('old-branch')
          : method === 'repo.list'
            ? { repos: [] }
            : method === 'repo.baseRefDefault'
              ? { defaultBaseRef: null }
              : method === 'settings.get'
                ? { settings: {} }
                : method === 'worktree.show'
                  ? { worktree: { branch: switched ? 'new-branch' : 'old-branch' } }
                  : method === 'hostedReview.forBranch'
                    ? null
                    : method === 'github.prForBranch'
                      ? pullRequest
                      : method === 'github.prChecks'
                        ? []
                        : method === 'status.get'
                          ? {
                              runtimeId: 'a',
                              hostDescriptor: { installationId: 'a' },
                              capabilities: ['github.exact-work-item-target.v1']
                            }
                          : method === 'github.workItemDetails'
                            ? {
                                item: {
                                  ...pullRequest,
                                  id: 'PR_93',
                                  type: 'pr',
                                  labels: [],
                                  updatedAt: '',
                                  author: null
                                },
                                body: detailsBody,
                                comments: []
                              }
                            : method === 'github.listAssignableUsers'
                              ? [{ login: 'fork-only', name: null, avatarUrl: '' }]
                              : undefined
    if (value === undefined) {
      throw new Error(`unexpected ${method}`)
    }
    return rpcSuccess(method, value)
  }
  await act(async () => {
    tree = create(createElement(MobileSourceControlPanel, { hostId: 'host-a', worktreeId: 'wt-1' }))
  })
  expect(requests.filter((r) => r.method === 'github.prForBranch')).toHaveLength(1)
  expect(requests.filter((r) => r.method === 'github.workItemDetails')).toHaveLength(0)
  const beforeSwitch = requests.length
  switched = true
  await act(async () =>
    tree!.update(createElement(MobileSourceControlPanel, { hostId: 'host-a', worktreeId: 'wt-2' }))
  )
  const readMethods = new Set([
    'worktree.show',
    'hostedReview.forBranch',
    'github.prForBranch',
    'github.prChecks',
    'github.workItemDetails'
  ])
  expect(requests.slice(beforeSwitch).filter((r) => readMethods.has(r.method))).toEqual([])
  expect(pendingProbes).toHaveLength(1)
  expect(pendingStatuses).toHaveLength(1)
  await act(async () => pendingProbes.shift()!(rpcSuccess('probe-w2', repository)))
  expect(requests.slice(beforeSwitch).filter((r) => readMethods.has(r.method))).toEqual([])
  await act(async () => pendingStatuses.shift()!(rpcSuccess('status-w2', status('new-branch'))))
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
  expect(requests.filter((r) => r.method === 'github.workItemDetails')).toHaveLength(0)
  await act(async () =>
    tree!.update(
      createElement(MobileSourceControlPanel, {
        hostId: 'host-a',
        worktreeId: 'wt-2',
        initialTab: 'pr'
      })
    )
  )
  expect(requests.filter((r) => r.method === 'github.workItemDetails')).toHaveLength(1)

  const count = (method: string) => requests.filter((r) => r.method === method).length
  const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
  const hasText = (value: string) =>
    tree!.root.findAll((node) => String(node.type) === 'Text' && node.props.children === value)
      .length > 0
  const composer = () => tree!.root.find((node) => String(node.type) === 'MessageBox')
  const search = () =>
    tree!.root.find(
      (node) => String(node.type) === 'TextField' && node.props.placeholder === 'Search people'
    )
  const press = (label: string) =>
    act(async () =>
      tree!.root
        .find(
          (node) => String(node.type) === 'Pressable' && node.props.accessibilityLabel === label
        )
        .props.onPress()
    )
  await settle()
  await act(async () => composer().props.onChangeText('unsent draft'))
  await press('Add or remove reviewers')
  await settle()
  expect(hasText('fork-only')).toBe(true)
  await act(async () => search().props.onChangeText('fork'))
  holdPr = true
  holdUsers = true
  await act(async () => doubles.refetchPr!({ includeDetails: true }))
  await settle()
  expect(heldPr).toHaveLength(1)
  const prReadsBefore = count('github.prForBranch')
  const detailReads = count('github.workItemDetails')

  // A connected-to-connected replacement, then an ordinary parent render with the same branch and PR.
  const next = createFakeRpcClient()
  next.sendRequest = physical.sendRequest
  await act(async () => client.migrateTo(next, 'lan'))
  await act(async () =>
    tree!.update(
      createElement(MobileSourceControlPanel, {
        hostId: 'host-a',
        worktreeId: 'wt-2',
        initialTab: 'pr'
      })
    )
  )
  // The previous build selected a fresh hidden PR here, unmounting the draft, picker and rows.
  expect(composer().props.value).toBe('unsent draft')
  expect(search().props.value).toBe('fork')
  expect(hasText('fork-only')).toBe(true)
  expect(hasText('Loading pull request…')).toBe(false)

  // The connection event alone started one successor while the retired read is still unresolved.
  await settle()
  expect(count('github.prForBranch')).toBe(prReadsBefore + 1)
  expect(heldPr).toHaveLength(2)
  expect(heldUsers).toHaveLength(1)
  await act(async () =>
    heldPr.shift()!.resolve(rpcSuccess('retired', { ...pullRequest, title: 'retired' }))
  )
  await settle()
  expect(count('github.workItemDetails')).toBe(detailReads)
  expect(composer().props.value).toBe('unsent draft')
  await act(async () => heldPr.shift()!.resolve(rpcSuccess('successor', pullRequest)))
  await settle()
  expect(count('github.workItemDetails')).toBe(detailReads + 1)
  expect(composer().props.value).toBe('unsent draft')
  await act(async () =>
    heldUsers.shift()!.resolve(
      rpcSuccess('users', [
        { login: 'fork-only', name: null, avatarUrl: '' },
        { login: 'fork-second', name: null, avatarUrl: '' }
      ])
    )
  )
  await settle()
  expect(hasText('fork-second')).toBe(true)
  expect(search().props.value).toBe('fork')

  // A failed background read keeps the accepted PR, picker and draft; a later success updates in place.
  await act(async () => doubles.refetchPr!({ includeDetails: false }))
  await settle()
  await act(async () => heldPr.shift()!.reject(new Error('socket closed')))
  await settle()
  expect(hasText('Loading pull request…')).toBe(false)
  expect(hasText('socket closed')).toBe(false)
  expect(composer().props.value).toBe('unsent draft')
  expect(hasText('fork-second')).toBe(true)
  detailsBody = 'refreshed body'
  await act(async () => doubles.refetchPr!({ includeDetails: true }))
  await settle()
  await act(async () => heldPr.shift()!.resolve(rpcSuccess('current', pullRequest)))
  await settle()
  expect(tree!.root.find((node) => String(node.type) === 'CommentMarkdown').props.content).toBe(
    'refreshed body'
  )
  expect(composer().props.value).toBe('unsent draft')
  expect(search().props.value).toBe('fork')
})
