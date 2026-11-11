import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeRpcClient } from '../../mobile-web-shell/bridge-host-test-fakes'

import type { ReviewScreenState } from './mobile-diff-review-screen-model'
import { useMobileDiffReviewController } from './use-mobile-diff-review-controller'
import { documentQueryClient } from '../../test-support/rpc-recording/hook-mount'
import { publishPageDeviceStore } from '../../mobile-web-shell/bridge/page-device-store'
import { resetDurableDraftFieldsForTests } from '../../drafts/durable-draft-fields'
import { publishInMemoryDeviceStore } from '../../drafts/in-memory-device-store.test-support'

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
vi.mock('../../layout/responsive-layout', () => ({ useResponsiveLayout: () => layout }))
vi.mock('../../components/MobileDiffReviewBody', () => ({ MobileDiffReviewBody: () => null }))
vi.mock('../../components/MobileDiffReviewDrawers', () => ({ MobileDiffReviewDrawers: () => null }))
vi.mock('../../components/MobileDiffReviewFileSummary', () => ({
  MobileDiffReviewFileSummary: () => null
}))
vi.mock('../../components/MobileDiffReviewFooter', () => ({ MobileDiffReviewFooter: () => null }))
vi.mock('../../components/MobileDiffReviewHeader', () => ({ MobileDiffReviewHeader: () => null }))
vi.mock('../../components/use-mobile-diff-review-overflow-actions', () => ({
  useMobileDiffReviewOverflowActions: () => ({})
}))
vi.mock('../../components/MobilePRSidebar', () => ({ MobilePRSidebar: () => null }))
vi.mock('../../components/RightDrawer', () => ({ RightDrawer: () => null }))
// The view only hands these to the mocked drawers; the real module pulls the comment and animation tree.
vi.mock('../../components/pr-sidebar/PRCommentsSection', () => ({
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

  beforeEach(() => {
    loadSnapshot.mockReset()
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    resetDurableDraftFieldsForTests()
    publishPageDeviceStore(null)
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

    it('brings an unsaved new note back after the app is killed, not the text of an edit', async () => {
      // The shell's draft table outlives the page; nothing else does.
      const table = new Map<string, string>()
      publishInMemoryDeviceStore(table)
      const openReview = async () => {
        loadSnapshot.mockResolvedValueOnce(unstaged(['c.ts']))
        await act(async () => {
          renderer = create(queries.wrap(createElement(StageProbe)))
          await new Promise((resolve) => setTimeout(resolve, 0))
        })
      }
      await openReview()
      act(() => controller?.openComposer(3))
      act(() => controller?.setComposerBody('rename this'))
      act(() => controller?.closeComposer())
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
      act(() => controller?.setComposerBody('older note, edited'))
      // The draft row saves once typing settles.
      await act(async () => {
        await vi.waitFor(() => expect(table.size).toBe(1))
      })
      act(() => renderer?.unmount())
      resetDurableDraftFieldsForTests()

      await openReview()
      act(() => controller?.openComposer(3))
      expect(controller?.composerBody).toBe('rename this')
    })
  })
})
