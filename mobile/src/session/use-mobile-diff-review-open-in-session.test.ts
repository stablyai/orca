import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ActionSheetAction } from '../components/ActionSheetModal'
import { MobileDiffReviewDrawers } from '../components/MobileDiffReviewDrawers'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import type { ReviewScreenState } from './mobile-diff-review-screen-model'
import { useMobileDiffReviewController } from './use-mobile-diff-review-controller'
import { SESSION_TABS_UNAVAILABLE_MESSAGE } from './use-mobile-diff-review-interactions'

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
  Platform: { OS: 'ios' },
  KeyboardAvoidingView: 'KeyboardAvoidingView',
  Pressable: 'Pressable',
  Text: 'Text',
  TextInput: 'TextInput',
  View: 'View'
}))
vi.mock('lucide-react-native', () => ({
  Check: 'Check',
  Copy: 'Copy',
  FileText: 'FileText',
  Plus: 'Plus',
  Send: 'Send',
  Trash2: 'Trash2',
  X: 'X'
}))
vi.mock('../components/ActionSheetModal', () => ({
  ActionSheetModal: (props: { title: string; actions: ActionSheetAction[] }) => {
    sheets.actions.set(props.title, props.actions)
    return null
  }
}))
vi.mock('../components/BottomDrawer', () => ({ BottomDrawer: () => null }))
vi.mock('../components/ConfirmModal', () => ({ ConfirmModal: () => null }))
vi.mock('../components/mobile-diff-review-screen-styles', () => ({ mobileDiffReviewStyles: {} }))
vi.mock('../platform/keyboard-occlusion', () => ({ useKeyboardAvoidingPadding: () => 0 }))
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

function openInSessionAction(): ActionSheetAction {
  const action = sheets.actions.get('Review Actions')?.find((a) => a.label === 'Open in Session')
  if (!action) {
    throw new Error('Open in Session is not in the review actions')
  }
  return action
}

describe('review screen Open in Session', () => {
  let renderer: ReactTestRenderer | null = null
  let controller: Controller | null = null

  async function mount(client: RpcClient, onOpenSession: () => void): Promise<void> {
    function Probe() {
      const current = useMobileDiffReviewController({
        client,
        connState: 'connected',
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

  it('explains a host with no renderer, and asks again on the next tap (#14315)', async () => {
    // A serve host can gain a window, or the client be replaced, while the review stays open.
    const { client } = clientAnsweringOpenDiff([NO_RENDERER, OPENED])
    const onOpenSession = vi.fn()
    await mount(client, onOpenSession)

    await press(openInSessionAction())
    expect(onOpenSession).not.toHaveBeenCalled()
    expect(controller?.actionError).toBe(SESSION_TABS_UNAVAILABLE_MESSAGE)
    expect(openInSessionAction().disabled).toBe(false)

    await press(openInSessionAction())
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
