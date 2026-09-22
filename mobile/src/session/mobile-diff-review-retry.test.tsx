import { createElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

const loadSnapshot = vi.hoisted(() => vi.fn(() => new Promise(() => {})))
vi.mock('./mobile-diff-review-loaders', () => ({
  loadMobileDiffReviewSnapshot: loadSnapshot,
  loadMobileDiffReviewDiff: vi.fn().mockResolvedValue({ kind: 'idle' })
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
vi.mock('lucide-react-native', () => ({ RefreshCw: 'Icon' }))
vi.mock('../components/MobileDiffReviewLine', () => ({ MobileDiffReviewLine: () => null }))
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

let tree: ReactTestRenderer | null = null

afterEach(() => {
  act(() => tree?.unmount())
  tree = null
})

/** The review body as the screen view wires it, for a host the shell has not reached. */
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
    hostId: 'host-1',
    worktreeId: 'wt-1',
    name: 'review',
    initialFilter: 'all',
    initialTarget: null,
    onOpenSession: () => {},
    onReconnect
  })
  return createElement(MobileDiffReviewBody, {
    activeHunkIndex: controller.activeHunkIndex,
    commentsByLine: controller.commentsByLine,
    currentItem: controller.currentItem,
    diffState: controller.diffState,
    filteredCount: controller.filteredQueue.length,
    listRef: controller.listRef,
    screenState: controller.screenState,
    staleCommentIds: controller.staleCommentIds,
    onAddNote: controller.openComposer,
    onEditNote: controller.openEditComposer,
    onRetry: controller.retryAction ?? undefined
  })
}

async function render(onReconnect: ((hostId: string) => void) | null): Promise<ReactTestRenderer> {
  await act(async () => {
    tree = create(createElement(ReviewWhileUnreachable, { onReconnect }))
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
      String(node.type) === 'Pressable' && node.props.accessibilityLabel === 'Retry loading review'
  )
}

describe('the review Retry while the host is unreachable', () => {
  it('is absent on the page, where nothing can re-dial', async () => {
    const rendered = await render(null)
    expect(
      rendered.root.findAll((node) => node.props.children === 'Waiting for desktop...')
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
        createElement(ReviewWhileUnreachable, { onReconnect: null, client, connState: 'connected' })
      )
    })
    expect(loadSnapshot.mock.calls).toEqual([[client, 'wt-1']])
  })
})
