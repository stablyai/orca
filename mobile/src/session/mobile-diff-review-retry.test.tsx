import { createElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

const loadSnapshot = vi.hoisted(() =>
  vi.fn((_client: unknown, _worktree: string) => new Promise(() => {}))
)
// Each build's notes-and-files read; status comes from the shared git.status query, held pending here.
vi.mock('./mobile-diff-review-snapshot-loader', () => ({
  startMobileDiffReviewSnapshot: (
    client: unknown,
    worktree: string,
    input: { status: Promise<unknown> }
  ) => {
    input.status.catch(() => {})
    return { snapshot: loadSnapshot(client, worktree), branch: Promise.resolve({ result: null }) }
  },
  withMobileDiffReviewBranch: (state: unknown) => state
}))
vi.mock('./mobile-diff-review-loaders', () => ({
  loadMobileDiffReviewDiff: vi.fn().mockResolvedValue({ kind: 'idle' }),
  mobileReviewDiffInput: vi.fn(() => ({}))
}))
vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  FlatList: 'FlatList',
  Platform: { OS: 'ios' },
  Pressable: 'Pressable',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: 'Text',
  View: 'View'
}))
vi.mock('lucide-react-native', () => ({
  ArrowDown: 'Icon',
  ArrowDownUp: 'Icon',
  ArrowUp: 'Icon',
  Check: 'Icon',
  CloudUpload: 'Icon',
  GitBranch: 'Icon',
  GitPullRequestArrow: 'Icon',
  History: 'Icon',
  RefreshCw: 'Icon',
  ChevronsUpDown: 'Icon',
  CircleAlert: 'Icon',
  FileText: 'Icon',
  ListChecks: 'Icon',
  SearchX: 'Icon',
  WifiOff: 'Icon'
}))
vi.mock('../components/MobileDiffReviewLine', () => ({ MobileDiffReviewLine: () => null }))
vi.mock('react-native-gesture-handler', () => ({ Gesture: {}, GestureDetector: () => null }))
vi.mock('../components/pr-sidebar/PRCommentsSection', () => ({ CommentGroupView: () => null }))
vi.mock('expo-haptics', () => ({
  impactAsync: vi.fn(),
  notificationAsync: vi.fn(),
  selectionAsync: vi.fn(),
  performAndroidHapticsAsync: vi.fn(),
  AndroidHaptics: {},
  ImpactFeedbackStyle: {},
  NotificationFeedbackType: {}
}))
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }))

import { MobileDiffReviewBody } from '../components/MobileDiffReviewBody'
import { createFakeRpcClient } from '../mobile-web-shell/bridge-host-test-fakes'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'
import { useMobileDiffReviewController } from './use-mobile-diff-review-controller'
import { documentQueryClient } from '../test-support/rpc-recording/hook-mount'

let tree: ReactTestRenderer | null = null
let queries = documentQueryClient()

afterEach(() => {
  act(() => tree?.unmount())
  tree = null
})

function ReviewWhileUnreachable({
  onReconnect,
  client = null,
  connState = 'reconnecting'
}: {
  onReconnect: ((hostId: string) => void) | null
  client?: RpcClient | null
  connState?: ConnectionState
}) {
  const controller = useMobileDiffReviewController({
    client,
    connState,
    hostCapabilities: [],
    hostStatusPending: false,
    hostStatusReadable: true,
    hostId: 'host-1',
    worktreeId: 'wt-1',
    name: 'review',
    initialFilter: 'all',
    initialTarget: null,
    commitOid: null,
    onOpenSession: () => {},
    onReconnect
  })
  return createElement(MobileDiffReviewBody, {
    commentsByLine: controller.commentsByLine,
    currentItem: controller.currentItem,
    diffState: controller.diffState,
    filteredCount: controller.filteredQueue.length,
    screenState: controller.screenState,
    staleCommentIds: controller.staleCommentIds,
    threadsByLine: new Map(),
    threadActions: undefined,
    selectedRange: null,
    onPickLines: () => {},
    scrollToLine: null,
    onScrolledToLine: () => {},
    onEditNote: controller.openEditComposer,
    onRetry: controller.retryAction ?? undefined,
    offline: connState !== 'connected',
    filter: controller.filter,
    onBack: () => {}
  })
}

async function render(onReconnect: ((hostId: string) => void) | null): Promise<ReactTestRenderer> {
  await act(async () => {
    queries = documentQueryClient()
    tree = create(queries.wrap(createElement(ReviewWhileUnreachable, { onReconnect })))
    await Promise.resolve()
  })
  if (tree === null) {
    throw new Error('the review did not render')
  }
  return tree
}

function retryControls(rendered: ReactTestRenderer): ReactTestInstance[] {
  return rendered.root.findAll(
    (node) =>
      String(node.type) === 'Pressable' &&
      node.findAll((child) => child.props.children === 'Reconnect').length > 0
  )
}

describe('the review Retry while the host is unreachable', () => {
  it('is absent on the page, where nothing can re-dial', async () => {
    const rendered = await render(null)
    expect(
      rendered.root.findAll((node) => node.props.children === 'Waiting for desktop')
    ).not.toHaveLength(0)
    expect(retryControls(rendered)).toHaveLength(0)
  })

  it('still renders natively and re-dials this host', async () => {
    const onReconnect = vi.fn()
    const [retry] = retryControls(await render(onReconnect))
    act(() => {
      retry?.props.onPress()
    })
    expect(onReconnect.mock.calls).toEqual([['host-1']])
  })

  it('loads again when the shell reconnects, which is what the missing Retry relies on', async () => {
    const rendered = await render(null)
    expect(retryControls(rendered)).toHaveLength(0)
    loadSnapshot.mockClear()
    const client = createFakeRpcClient()
    await act(async () => {
      rendered.update(
        queries.wrap(
          createElement(ReviewWhileUnreachable, {
            onReconnect: null,
            client,
            connState: 'connected'
          })
        )
      )
    })
    expect(loadSnapshot).toHaveBeenCalledTimes(1)
    expect(loadSnapshot.mock.calls[0]?.slice(0, 2)).toEqual([client, 'wt-1'])
  })
})
