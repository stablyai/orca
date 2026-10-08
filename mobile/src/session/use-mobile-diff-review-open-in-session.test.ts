import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ActionSheetAction } from '../components/ActionSheetModal'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import type { ReviewScreenState } from './mobile-diff-review-screen-model'

const sheets = vi.hoisted(() => ({ actions: new Map<string, ActionSheetAction[]>() }))

vi.mock('./mobile-diff-review-loaders', () => ({
  loadMobileDiffReviewSnapshot: vi.fn().mockResolvedValue({
    kind: 'ready',
    status: {
      entries: [{ path: 'src/app.ts', status: 'modified', area: 'unstaged' }],
      conflictOperation: 'unknown',
      branch: 'feature',
      head: 'abc123',
      upstreamStatus: undefined
    },
    comments: [],
    reviewState: { version: 1, files: {} },
    branchCompare: null
  } satisfies ReviewScreenState),
  loadMobileDiffReviewDiff: vi.fn().mockResolvedValue({ kind: 'idle' })
}))
vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Platform: { OS: 'ios' },
  KeyboardAvoidingView: 'KeyboardAvoidingView',
  Pressable: 'Pressable',
  StyleSheet: { create: <T>(styles: T) => styles, hairlineWidth: 1 },
  Text: 'Text',
  TextInput: 'TextInput',
  View: 'View'
}))
vi.mock('lucide-react-native', () => ({
  Check: 'Check',
  Copy: 'Copy',
  Edit3: 'Edit3',
  FileText: 'FileText',
  Plus: 'Plus',
  Send: 'Send',
  Trash2: 'Trash2',
  X: 'X'
}))
vi.mock('../components/ActionSheetModal', () => ({
  ActionSheetContent: (props: { title: string; actions: ActionSheetAction[] }) => {
    sheets.actions.set(props.title, props.actions)
    return null
  }
}))
vi.mock('../components/mounted-bottom-drawer', () => ({
  MountedBottomDrawer: 'MountedBottomDrawer'
}))
vi.mock('../components/mobile-diff-review-screen-styles', () => ({
  mobileDiffReviewStyles: new Proxy({}, { get: () => ({}) })
}))
vi.mock('./use-mobile-pr-sidebar-controller', () => ({
  useMobilePrSidebarController: () => ({})
}))
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

const { MobileDiffReviewDrawers } = await import('../components/MobileDiffReviewDrawers')
const { useMobileDiffReviewController } = await import('./use-mobile-diff-review-controller')
const { OPEN_IN_SESSION_NEEDS_HOST_UPDATE_MESSAGE } =
  await import('./use-mobile-diff-review-interactions')

type Controller = ReturnType<typeof useMobileDiffReviewController>

const NO_RENDERER: RpcResponse = {
  id: 'request-1',
  ok: false,
  error: { code: 'runtime_error', message: 'renderer_unavailable' }
}
const OPENED: RpcResponse = { id: 'request-1', ok: true, result: { opened: true } }

function clientAnsweringOpenDiff(replies: RpcResponse[]) {
  const send = vi.fn(async (method: string, _params?: unknown) =>
    method === 'files.openDiff' ? replies.shift() : new Promise<RpcResponse>(() => {})
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the controller only sends requests through this client.
  return { client: { sendRequest: send } as unknown as RpcClient, send }
}

describe('review screen Open in Session', () => {
  let renderer: ReactTestRenderer | null = null
  let controller: Controller | null = null

  async function mount(client: RpcClient, onOpenSession: () => void): Promise<void> {
    function Probe() {
      const current = useMobileDiffReviewController({
        client,
        connState: 'connected',
        hostCapabilities: [],
        hostStatusPending: false,
        hostStatusReadable: true,
        hostId: 'host-1',
        worktreeId: 'wt-1',
        name: 'review',
        initialFilter: 'all',
        initialTarget: null,
        onOpenSession,
        onReconnect: () => {}
      })
      controller = current
      return createElement(MobileDiffReviewDrawers, { controller: current })
    }
    await act(async () => {
      renderer = create(createElement(Probe))
      await Promise.resolve()
    })
    if (!controller?.currentItem) {
      throw new Error('review did not load a file')
    }
  }

  function openInSessionAction(): ActionSheetAction {
    act(() => controller?.openSheet({ kind: 'actions' }))
    const action = sheets.actions.get('Review Actions')?.find((a) => a.label === 'Open in Session')
    if (!action) {
      throw new Error('Open in Session is not in the review actions')
    }
    return action
  }

  async function press(action: ActionSheetAction): Promise<void> {
    await act(async () => {
      action.onPress()
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    controller = null
    sheets.actions.clear()
  })

  it('explains an older host with no desktop window, and asks again on the next tap (#14315)', async () => {
    // The host can gain a window, or be updated, while the review stays open.
    const { client, send } = clientAnsweringOpenDiff([NO_RENDERER, OPENED])
    const onOpenSession = vi.fn()
    await mount(client, onOpenSession)

    await press(openInSessionAction())
    expect(onOpenSession).not.toHaveBeenCalled()
    expect(controller?.actionError).toBe(OPEN_IN_SESSION_NEEDS_HOST_UPDATE_MESSAGE)
    expect(controller?.actionError).not.toContain('renderer_unavailable')
    expect(openInSessionAction().disabled).toBe(false)

    await press(openInSessionAction())
    expect(send.mock.calls.filter(([method]) => method === 'files.openDiff')).toHaveLength(2)
    expect(onOpenSession).toHaveBeenCalledTimes(1)
  })

  it('returns to the session when a desktop host opens the diff tab', async () => {
    const { client, send } = clientAnsweringOpenDiff([OPENED])
    const onOpenSession = vi.fn()
    await mount(client, onOpenSession)

    await press(openInSessionAction())

    expect(send.mock.calls.find(([method]) => method === 'files.openDiff')?.[1]).toMatchObject({
      worktree: 'id:wt-1',
      relativePath: 'src/app.ts',
      staged: false
    })
    expect(onOpenSession).toHaveBeenCalledTimes(1)
  })
})
