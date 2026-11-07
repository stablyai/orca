import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeRpcClient, rpcSuccess } from '../mobile-web-shell/bridge-host-test-fakes'
import { MobileDiffReviewScreenView } from '../components/MobileDiffReviewScreenView'
import type { ConnectionState, RpcResponse } from '../transport/types'
import type { ReviewScreenState } from './mobile-diff-review-screen-model'
import { useMobileDiffReviewController } from './use-mobile-diff-review-controller'
import { documentQueryClient } from '../test-support/rpc-recording/hook-mount'

const loadSnapshot = vi.hoisted(() => vi.fn())
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
// The view only hands these to the mocked drawers; the real module pulls the comment and animation tree.
vi.mock('../components/pr-sidebar/PRCommentsSection', () => ({
  usePRCommentCardActions: () => undefined
}))
vi.mock('expo-haptics', () => ({
  impactAsync: vi.fn(async () => {}),
  notificationAsync: vi.fn(async () => {}),
  selectionAsync: vi.fn(async () => {}),
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
  const queries = documentQueryClient()
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
      commitOid: null,
      onOpenSession: () => {},
      onReconnect: () => {}
    })
    screenState = controller.screenState
    return null
  }

  async function update(connState: ConnectionState): Promise<void> {
    await act(async () => {
      renderer?.update(queries.wrap(createElement(Probe, { connState })))
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
      renderer = create(queries.wrap(createElement(Probe, { connState: 'connected' })))
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
      renderer = create(queries.wrap(createElement(Probe, { connState: 'connected' })))
      await Promise.resolve()
    })
    expect(screenState).toMatchObject({ kind: 'ready' })

    await update('reconnecting')
    await update('connected')
    expect(loadSnapshot).toHaveBeenCalledTimes(2)
    expect(screenState).toMatchObject({ kind: 'ready', status: { branch: 'feature/one' } })
  })

  describe('Stage · next file', () => {
    let controller: ReturnType<typeof useMobileDiffReviewController> | null = null

    function unstaged(paths: string[]): ReviewScreenState {
      const ready = readySnapshot('feature/one')
      return ready.kind === 'ready'
        ? {
            ...ready,
            status: {
              ...ready.status,
              entries: paths.map((path) => ({ path, status: 'modified', area: 'unstaged' }))
            }
          }
        : ready
    }

    function StageProbe(): null {
      controller = useMobileDiffReviewController({
        client,
        connState: 'connected',
        hostCapabilities: [],
        hostStatusPending: false,
        hostStatusReadable: true,
        hostId: 'host-1',
        worktreeId: 'wt-1',
        name: 'review',
        initialFilter: 'unstaged',
        initialTarget: { filePath: 'c.ts', area: 'unstaged' },
        commitOid: null,
        onOpenSession: () => {},
        onReconnect: () => {}
      })
      return null
    }

    async function stageCurrent(whileStaging?: () => void): Promise<void> {
      loadSnapshot.mockResolvedValueOnce(unstaged(['a.ts', 'b.ts', 'c.ts']))
      await act(async () => {
        renderer = create(queries.wrap(createElement(StageProbe)))
        await Promise.resolve()
      })
      expect(controller?.currentItem?.filePath).toBe('c.ts')
      loadSnapshot.mockResolvedValueOnce(unstaged(['a.ts', 'b.ts']))
      let staging: Promise<void> | undefined
      act(() => {
        staging = controller?.stageAndOpenNext()
      })
      act(() => whileStaging?.())
      const stage = client.requests.find((request) => request.method === 'git.stage')
      await act(async () => {
        stage?.resolve({
          id: 'stage',
          ok: true,
          result: { staged: true },
          _meta: { runtimeId: 'r' }
        })
        await staging
      })
    }

    beforeEach(() => {
      client.requests.length = 0
    })

    it('keeps a file the reader picked while the stage was running', async () => {
      await stageCurrent(() => controller?.moveFile('previous'))
      expect(controller?.currentItem?.filePath).toBe('b.ts')
    })

    it('keeps an unsaved note across reopen and edits, and clears it once saved', async () => {
      loadSnapshot.mockResolvedValueOnce(unstaged(['c.ts']))
      await act(async () => {
        renderer = create(queries.wrap(createElement(StageProbe)))
        await Promise.resolve()
      })
      act(() => controller?.openComposer(3))
      act(() => controller?.setComposerBody('rename this'))
      act(() => controller?.closeComposer())
      act(() => controller?.openNewNoteSheet({ kind: 'range', startLine: 5, line: 7 }))
      expect(controller?.composerBody).toBe('rename this')

      act(() => controller?.closeSheet('range'))
      act(() =>
        controller?.openEditComposer({
          id: 'saved',
          worktreeId: 'wt-1',
          filePath: 'c.ts',
          lineNumber: 1,
          side: 'modified',
          body: 'older note',
          createdAt: 1
        })
      )
      expect(controller?.composerBody).toBe('older note')
      act(() => controller?.closeComposer())
      act(() => controller?.openComposer(3))
      expect(controller?.composerBody).toBe('rename this')

      let saving: Promise<void> | undefined
      act(() => {
        saving = controller?.saveComposer()
      })
      const save = client.requests.find((request) => request.method === 'worktree.set')
      await act(async () => {
        save?.resolve({ id: 'save', ok: true, result: {}, _meta: { runtimeId: 'r' } })
        await saving
      })
      act(() => controller?.openComposer(3))
      expect(controller?.composerBody).toBe('')
    })
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
  const screenQueries = documentQueryClient()
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
      commitOid: null,
      initialTarget: null,
      onOpenSession: () => {},
      onReconnect: () => {}
    })
    return createElement(MobileDiffReviewScreenView, {
      controller,
      hostConnection: {
        reconnectAttempts: 0,
        lastConnectedAt: null,
        pendingPath: null,
        pairingRejected: false,
        relayHostReachability: 'connecting'
      },
      onBack: () => {}
    })
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
      rendered = create(screenQueries.wrap(createElement(Screen)))
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
    await act(async () => rendered!.update(screenQueries.wrap(createElement(Screen))))
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
