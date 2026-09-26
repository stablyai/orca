import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

// iOS cannot present the Send Notes sheet while another native sheet is still on screen: the
// second presentation silently fails and every later tap on the screen is swallowed.

vi.mock('react-native', () => ({
  KeyboardAvoidingView: 'KeyboardAvoidingView',
  Platform: { OS: 'ios' },
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
vi.mock('../platform/keyboard-occlusion', () => ({ useKeyboardAvoidingPadding: () => 0 }))
vi.mock('./mobile-diff-review-screen-styles', () => ({
  mobileDiffReviewStyles: new Proxy({}, { get: () => ({}) })
}))
vi.mock('./ConfirmModal', () => ({ ConfirmModal: 'ConfirmModal' }))
vi.mock('./ActionSheetModal', () => ({ ActionSheetModal: 'ActionSheetModal' }))
vi.mock('./BottomDrawer', () => ({ BottomDrawer: 'BottomDrawer' }))

const { MobileDiffReviewDrawers } = await import('./MobileDiffReviewDrawers')

type Controller = Parameters<typeof MobileDiffReviewDrawers>[0]['controller']

function controllerStub() {
  return {
    showOverflow: false,
    sendSheet: null,
    discardTarget: null,
    composer: null,
    composerBody: '',
    showCompletion: true,
    reviewedUnstagedCount: 0,
    busyAction: null,
    unsentComments: [{ id: 'note-1' }],
    currentItem: null,
    queue: [],
    screenState: { kind: 'ready', comments: [{ id: 'note-1' }] },
    openSendSheet: vi.fn(async () => {}),
    setShowOverflow: vi.fn(),
    setShowCompletion: vi.fn(),
    setSendSheet: vi.fn(),
    copyNotes: vi.fn(),
    clearSentNotes: vi.fn(),
    stageReviewedFiles: vi.fn(),
    markUnreviewed: vi.fn()
  }
}

let renderer: ReactTestRenderer | null = null

function actionLabeled(actions: unknown, label: string): { skipAutoClose?: unknown } | undefined {
  return Array.isArray(actions)
    ? actions.find(
        (action): action is { skipAutoClose?: unknown } =>
          typeof action === 'object' && action !== null && action.label === label
      )
    : undefined
}

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
})

function render(controller: ReturnType<typeof controllerStub>): ReactTestRenderer {
  act(() => {
    renderer = create(
      createElement(MobileDiffReviewDrawers, {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stub carries every controller member these drawers read; a missing one throws on use.
        controller: controller as unknown as Controller
      })
    )
  })
  return renderer!
}

describe('opening Send Notes from another sheet', () => {
  it('closes Review Actions before Send Unsent Notes opens the Send Notes sheet', () => {
    const tree = render({ ...controllerStub(), showCompletion: false })
    const overflow = tree.root.findAll(
      (node) => String(node.type) === 'ActionSheetModal' && node.props.title === 'Review Actions'
    )[0]!
    const send = actionLabeled(overflow.props.actions, 'Send Unsent Notes')

    // The sheet runs a closeBeforePress action only after its own native window has unmounted.
    expect(send).toMatchObject({ closeBeforePress: true })
    expect(send?.skipAutoClose).toBeUndefined()
  })

  it('closes Review Complete first and opens Send Notes only once it has fully closed', () => {
    const controller = controllerStub()
    const tree = render(controller)
    const completion = tree.root.findAll(
      (node) => String(node.type) === 'BottomDrawer' && node.props.visible === true
    )[0]!
    const sendButton = tree.root.findAll(
      (node) =>
        String(node.type) === 'Pressable' && node.props.accessibilityLabel === 'Send notes to agent'
    )[0]!

    act(() => sendButton.props.onPress())

    expect(controller.setShowCompletion).toHaveBeenCalledWith(false)
    expect(controller.openSendSheet).not.toHaveBeenCalled()

    act(() => completion.props.onAfterClose?.())

    expect(controller.openSendSheet).toHaveBeenCalledOnce()
  })

  it('does not open Send Notes when Review Complete closes for another reason', () => {
    const controller = controllerStub()
    const tree = render(controller)
    const completion = tree.root.findAll(
      (node) => String(node.type) === 'BottomDrawer' && node.props.visible === true
    )[0]!

    act(() => completion.props.onClose())
    act(() => completion.props.onAfterClose?.())

    expect(controller.openSendSheet).not.toHaveBeenCalled()
  })
})
