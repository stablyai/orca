import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeRpcClient, rpcSuccess } from '../mobile-web-shell/bridge-host-test-fakes'
import { MobileDiffReviewScreenView } from '../components/MobileDiffReviewScreenView'
import type { ConnectionState, RpcResponse } from '../transport/types'
import type { ReviewScreenState } from './mobile-diff-review-screen-model'
import { useMobileDiffReviewController } from './use-mobile-diff-review-controller'

const loadSnapshot = vi.hoisted(() => vi.fn())
vi.mock('./mobile-diff-review-loaders', () => ({
  loadMobileDiffReviewSnapshot: loadSnapshot,
  loadMobileDiffReviewDiff: vi.fn().mockResolvedValue({ kind: 'idle' })
}))
vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  View: 'View',
  Text: 'Text',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 }
}))
vi.mock('react-native-safe-area-context', () => ({
  SafeAreaView: 'SafeAreaView',
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 })
}))
const layout = vi.hoisted(() => ({ isWideLayout: true }))
vi.mock('../layout/responsive-layout', () => ({ useResponsiveLayout: () => layout }))
vi.mock('../components/MobileDiffReviewBody', () => ({ MobileDiffReviewBody: () => null }))
vi.mock('../components/MobileDiffReviewDrawers', () => ({ MobileDiffReviewDrawers: () => null }))
vi.mock('../components/MobileDiffReviewFileSummary', () => ({
  MobileDiffReviewFileSummary: () => null
}))
vi.mock('../components/MobileDiffReviewFooter', () => ({ MobileDiffReviewFooter: () => null }))
vi.mock('../components/MobileDiffReviewHeader', () => ({ MobileDiffReviewHeader: () => null }))
vi.mock('../components/use-mobile-diff-review-overflow-actions', () => ({
  useMobileDiffReviewOverflowActions: () => ({})
}))
vi.mock('../components/MobilePRSidebar', () => ({ MobilePRSidebar: () => null }))
vi.mock('../components/RightDrawer', () => ({ RightDrawer: () => null }))
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

const client = createFakeRpcClient()

function readySnapshot(branch: string): ReviewScreenState {
  return {
    kind: 'ready',
    status: {
      entries: [],
      branch,
      head: 'abc123',
      conflictOperation: undefined,
      upstreamStatus: undefined
    },
    comments: [],
    reviewState: { version: 1, files: {} },
    branchCompare: null
  }
}

describe('useMobileDiffReviewController', () => {
  let renderer: ReactTestRenderer | null = null
  let screenState: ReviewScreenState = { kind: 'loading' }

  function Probe({ connState }: { connState: ConnectionState }): null {
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
      onOpenSession: () => {},
      onReconnect: () => {}
    })
    screenState = controller.screenState
    return null
  }

  async function update(connState: ConnectionState): Promise<void> {
    await act(async () => {
      renderer?.update(createElement(Probe, { connState }))
      await Promise.resolve()
    })
  }

  beforeEach(() => {
    loadSnapshot.mockReset()
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  it('keeps the loaded review across a disconnect and its reconnect reload', async () => {
    let releaseReload: (() => void) | null = null
    loadSnapshot.mockResolvedValueOnce(readySnapshot('feature/one')).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseReload = () => resolve(readySnapshot('feature/two'))
        })
    )

    await act(async () => {
      renderer = create(createElement(Probe, { connState: 'connected' }))
      await Promise.resolve()
    })
    expect(screenState).toMatchObject({ kind: 'ready' })

    await update('reconnecting')
    expect(screenState).toMatchObject({ kind: 'ready', status: { branch: 'feature/one' } })

    await update('connected')
    expect(screenState).toMatchObject({ kind: 'ready', status: { branch: 'feature/one' } })

    await act(async () => {
      releaseReload?.()
      await Promise.resolve()
    })
    expect(screenState).toMatchObject({ kind: 'ready', status: { branch: 'feature/two' } })
  })

  it('keeps the loaded review when the reconnect reload rejects', async () => {
    loadSnapshot
      .mockResolvedValueOnce(readySnapshot('feature/one'))
      .mockRejectedValueOnce(new Error('snapshot fetch failed'))

    await act(async () => {
      renderer = create(createElement(Probe, { connState: 'connected' }))
      await Promise.resolve()
    })
    expect(screenState).toMatchObject({ kind: 'ready' })

    await update('reconnecting')
    await update('connected')
    expect(loadSnapshot).toHaveBeenCalledTimes(2)
    expect(screenState).toMatchObject({ kind: 'ready', status: { branch: 'feature/one' } })
  })

  it('waits for the desktop when the drop lands before the review loads', async () => {
    loadSnapshot.mockReturnValueOnce(new Promise(() => {}))

    await act(async () => {
      renderer = create(createElement(Probe, { connState: 'connected' }))
      await Promise.resolve()
    })
    expect(screenState).toMatchObject({ kind: 'loading' })

    await update('disconnected')
    expect(screenState).toMatchObject({ kind: 'error', message: 'Waiting for desktop...' })
  })
})

it('runs the real Diff Review View dock demand before parent HEAD refresh without superseding full B details, and keeps overlay open and Retry', async () => {
  const rpc = createFakeRpcClient()
  let resource = 'a'
  const repository = (name: string) => ({ owner: name, repo: 'widgets', host: 'github.corp' })
  const pr = (name: string) => ({
    number: 93,
    title: name,
    state: 'open',
    url: `https://github.corp/${name}/widgets/pull/93`,
    prRepo: repository(name),
    headSha: `${name}-head`
  })
  const pending: { resource: string; resolve: (reply: RpcResponse) => void }[] = []
  const methods: string[] = []
  rpc.sendRequest = async (method) => {
    methods.push(method)
    if (method === 'github.workItemDetails') {
      return new Promise((resolve) => pending.push({ resource, resolve }))
    }
    const result =
      method === 'github.repoSlug'
        ? repository(resource)
        : method === 'worktree.show'
          ? { worktree: { branch: resource } }
          : method === 'hostedReview.forBranch'
            ? null
            : method === 'github.prForBranch'
              ? pr(resource)
              : method === 'github.prChecks'
                ? []
                : method === 'settings.get'
                  ? { settings: {} }
                  : method === 'status.get'
                    ? {
                        runtimeId: 'a',
                        hostDescriptor: { installationId: 'a' },
                        capabilities: ['github.exact-work-item-target.v1']
                      }
                    : undefined
    if (result === undefined) {
      throw new Error(`unexpected ${method}`)
    }
    return rpcSuccess(method, result)
  }
  const snapshot = (name: string) => {
    const result = readySnapshot(name)
    if (result.kind !== 'ready') {
      throw new Error('expected ready fixture')
    }
    return { ...result, status: { ...result.status, head: `${name}-head` } }
  }
  loadSnapshot
    .mockReset()
    .mockResolvedValueOnce(snapshot('a'))
    .mockResolvedValueOnce(snapshot('b'))
    .mockResolvedValueOnce(snapshot('c'))
  let controller: ReturnType<typeof useMobileDiffReviewController>
  let rendered: ReactTestRenderer | undefined
  function Screen() {
    controller = useMobileDiffReviewController({
      client: rpc,
      connState: 'connected',
      hostCapabilities: [],
      hostStatusPending: false,
      hostStatusReadable: true,
      hostId: 'host-1',
      worktreeId: 'wt-1',
      name: 'review',
      initialFilter: 'all',
      initialTarget: null,
      onOpenSession: () => {},
      onReconnect: () => {}
    })
    return createElement(MobileDiffReviewScreenView, { controller, onBack: () => {} })
  }
  const settle = async () => {
    const next = pending.shift()
    if (!next) {
      throw new Error('missing demanded details')
    }
    const item = {
      ...pr(next.resource),
      id: `PR_${next.resource}`,
      type: 'pr',
      labels: [],
      updatedAt: '',
      author: null
    }
    await act(async () =>
      next.resolve(
        rpcSuccess('details', {
          item,
          body: `${next.resource} body`,
          comments: [],
          pullRequestId: item.id
        })
      )
    )
    expect(controller!.prSidebarState).toMatchObject({
      kind: 'ready',
      data: { details: { body: `${next.resource} body` } }
    })
  }
  layout.isWideLayout = true
  try {
    await act(async () => {
      rendered = create(createElement(Screen))
    })
    // The actual View measures its row before choosing inline demand.
    const row = rendered!.root.findAll((node) => typeof node.props.onLayout === 'function')[0]
    expect(row).toBeDefined()
    await act(async () => row.props.onLayout({ nativeEvent: { layout: { width: 1400 } } }))
    expect(pending).toHaveLength(1)
    await settle()
    resource = 'b'
    const before = methods.length
    await act(async () => controller.retryAction?.())
    expect(controller!.prSidebarBranch).toBe('b')
    expect(controller!.prSidebarHeadSha).toBe('b-head')
    expect(methods.slice(before).filter((method) => method === 'github.prForBranch')).toHaveLength(
      1
    )
    expect(methods.slice(before).filter((method) => method === 'github.prChecks')).toHaveLength(1)
    expect(pending).toHaveLength(1)
    expect(pending[0].resource).toBe('b')
    await settle()
    if (controller!.prSidebarState.kind !== 'ready') {
      throw new Error('expected ready B')
    }
    const acceptedRepo = controller!.prSidebarState.data.pr.prRepo
    await act(async () => rendered!.update(createElement(Screen)))
    expect(
      controller!.prSidebarState.kind === 'ready' && controller!.prSidebarState.data.pr.prRepo
    ).toBe(acceptedRepo)

    layout.isWideLayout = false
    resource = 'c'
    const beforeOverlay = methods.filter((method) => method === 'github.prForBranch').length
    await act(async () => controller.retryAction?.())
    expect(controller!.prSidebarState).toEqual({ kind: 'hidden' })
    expect(methods.filter((method) => method === 'github.prForBranch')).toHaveLength(beforeOverlay)
    await act(async () => controller.openPRSidebar())
    expect(controller!.showPRSidebar).toBe(true)
    expect(pending).toHaveLength(1)
    await settle()
    await act(async () => controller.retryPRSidebar())
    expect(pending).toHaveLength(1)
    await settle()
  } finally {
    await act(async () => rendered?.unmount())
    layout.isWideLayout = true
  }
})
