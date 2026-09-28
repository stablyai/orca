import { createElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DiffComment } from '../../../src/shared/diff-comment-types'
import type { RpcClient } from '../transport/rpc-client'
import type { ReviewScreenState } from '../session/mobile-diff-review-screen-model'

// iOS cannot present a review sheet while another is still on screen (even mid-close): the second
// presentation silently fails and every later tap on the screen is swallowed. These drive the real
// controller and keyed drawer; only the native drawer is mocked, and its finished hide animation is
// played by calling its `onHidden`.

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  KeyboardAvoidingView: 'KeyboardAvoidingView',
  Platform: { OS: 'ios' },
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
vi.mock('expo-haptics', () => ({
  impactAsync: vi.fn(async () => {}),
  notificationAsync: vi.fn(async () => {}),
  selectionAsync: vi.fn(async () => {}),
  performAndroidHapticsAsync: vi.fn(async () => {}),
  AndroidHaptics: {},
  ImpactFeedbackStyle: {},
  NotificationFeedbackType: {}
}))
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }))
vi.mock('../platform/keyboard-occlusion', () => ({ useKeyboardAvoidingPadding: () => 0 }))
vi.mock('./mobile-diff-review-screen-styles', () => ({
  mobileDiffReviewStyles: new Proxy({}, { get: () => ({}) })
}))
vi.mock('./mounted-bottom-drawer', () => ({ MountedBottomDrawer: 'MountedBottomDrawer' }))
const loadSnapshot = vi.hoisted(() => vi.fn())
vi.mock('../session/mobile-diff-review-loaders', () => ({
  loadMobileDiffReviewSnapshot: loadSnapshot,
  loadMobileDiffReviewDiff: vi.fn().mockResolvedValue({ kind: 'idle' })
}))
vi.mock('../session/use-mobile-pr-sidebar-controller', () => ({
  useMobilePrSidebarController: () => ({})
}))

const { MobileDiffReviewDrawers } = await import('./MobileDiffReviewDrawers')
const { useMobileDiffReviewController } =
  await import('../session/use-mobile-diff-review-controller')

type Controller = ReturnType<typeof useMobileDiffReviewController>
type Deferred = { promise: Promise<unknown>; resolve: (value: unknown) => void }

function deferred(): Deferred {
  let resolve: (value: unknown) => void = () => {}
  const promise = new Promise<unknown>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

const NOTE: DiffComment = {
  id: 'note-1',
  worktreeId: 'wt-1',
  filePath: 'src/a.ts',
  lineNumber: 3,
  body: 'rename this',
  createdAt: 1,
  side: 'modified'
}

const SNAPSHOT: ReviewScreenState = {
  kind: 'ready',
  status: {
    entries: [{ path: 'src/a.ts', status: 'modified', area: 'unstaged' }],
    conflictOperation: undefined,
    upstreamStatus: undefined,
    branch: 'feature',
    head: 'abc123'
  },
  branchCompare: null,
  comments: [NOTE],
  reviewState: { version: 1, files: {} }
}

const TABS_REPLY = {
  id: 'tabs',
  ok: true,
  result: { tabs: [{ type: 'terminal', id: 'tab-1', terminal: 'terminal-1', title: 'codex' }] },
  _meta: { runtimeId: 'runtime' }
}
const SAVE_REPLY = { id: 'save', ok: true, result: {}, _meta: { runtimeId: 'runtime' } }

let renderer: ReactTestRenderer | null = null
let controller: Controller
let replies: Map<string, Deferred>

function Screen({ client }: { client: RpcClient }) {
  controller = useMobileDiffReviewController({
    client,
    connState: 'connected',
    hostId: 'host-1',
    worktreeId: 'wt-1',
    name: 'review',
    initialFilter: 'all',
    initialTarget: null,
    onOpenSession: () => {},
    onReconnect: null
  })
  return createElement(MobileDiffReviewDrawers, { controller })
}

/** Every RPC waits until the test answers it, so each case controls when a load or save lands. */
async function mountScreen(): Promise<void> {
  replies = new Map()
  const sendRequest = vi.fn((method: string) => {
    const reply = deferred()
    replies.set(method, reply)
    return reply.promise
  })
  loadSnapshot.mockResolvedValue(SNAPSHOT)
  await act(async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the operations under test only call `sendRequest`.
    renderer = create(createElement(Screen, { client: { sendRequest } as unknown as RpcClient }))
    await Promise.resolve()
  })
  expect(controller.currentItem).not.toBeNull()
}

async function answer(method: string, reply: unknown): Promise<void> {
  const pending = replies.get(method)
  expect(pending, `${method} was never requested`).toBeDefined()
  await act(async () => {
    pending?.resolve(reply)
    await new Promise((settle) => setTimeout(settle, 0))
  })
}

function textOf(node: ReactTestInstance): string[] {
  return node
    .findAll((child) => String(child.type) === 'Text')
    .flatMap((text) => text.children.filter((child) => typeof child === 'string'))
}

/** Every mounted native drawer: each is its own Modal, so there must never be two. */
function mountedDrawers(): ReactTestInstance[] {
  return renderer!.root.findAll((node) => String(node.type) === 'MountedBottomDrawer')
}

/** The mounted sheet, which must carry this title (the first text it renders). */
function drawer(title: string): ReactTestInstance {
  const [mounted, ...others] = mountedDrawers()
  expect(others).toEqual([])
  expect(mounted && textOf(mounted)[0]).toBe(title)
  return mounted!
}

function shownSheets(): string[] {
  const mounted = mountedDrawers()
  expect(mounted.length).toBeLessThanOrEqual(1)
  return mounted.filter((node) => node.props.visible === true).map((node) => textOf(node)[0]!)
}

function press(within: ReactTestInstance, label: string): void {
  const target = within.find(
    (node) =>
      String(node.type) === 'Pressable' &&
      (node.props.accessibilityLabel === label || textOf(node).includes(label))
  )
  act(() => target.props.onPress())
}

/** The drawer's native hide animation finished. */
function finishClosing(title: string): void {
  const closing = drawer(title)
  expect(closing.props.visible).toBe(false)
  act(() => closing.props.onHidden())
}

/** Marks the only file reviewed; the save stays in flight until `answer('worktree.set')`. */
function startMarkReviewed(): Promise<void> {
  let marking: Promise<void> = Promise.resolve()
  act(() => {
    marking = controller.markReviewed()
  })
  return marking
}

async function completeReview(): Promise<void> {
  const marking = startMarkReviewed()
  await answer('worktree.set', SAVE_REPLY)
  await act(() => marking)
}

beforeEach(() => {
  loadSnapshot.mockReset()
})

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
})

describe('review screen sheets never stack', () => {
  it('Send Unsent Notes shows Send Notes only after Review Actions has closed', async () => {
    await mountScreen()
    act(() => controller.openSheet({ kind: 'actions' }))
    expect(shownSheets()).toEqual(['Review Actions'])

    press(drawer('Review Actions'), 'Send Unsent Notes')
    expect(shownSheets()).toEqual([])

    await answer('session.tabs.list', TABS_REPLY)
    expect(shownSheets()).toEqual([])

    finishClosing('Review Actions')
    expect(shownSheets()).toEqual(['Send Notes'])
    expect(textOf(drawer('Send Notes'))).toContain('codex (termin)')
  })

  it('Review Complete → Send shows Send Notes only after Review Complete has closed', async () => {
    await mountScreen()
    await completeReview()
    expect(shownSheets()).toEqual(['Review Complete'])

    press(drawer('Review Complete'), 'Send notes to agent')
    expect(shownSheets()).toEqual([])

    finishClosing('Review Complete')
    expect(shownSheets()).toEqual(['Send Notes'])
  })

  it('does not open Send Notes when Review Complete closes for another reason', async () => {
    await mountScreen()
    await completeReview()

    act(() => drawer('Review Complete').props.onClose())
    finishClosing('Review Complete')

    expect(shownSheets()).toEqual([])
  })

  it('Review Complete arriving while another sheet is open waits for that sheet to close', async () => {
    await mountScreen()
    const marking = startMarkReviewed()
    // The user opens Review Actions while the save is still in flight.
    act(() => controller.openSheet({ kind: 'actions' }))
    await answer('worktree.set', SAVE_REPLY)
    await act(() => marking)
    expect(shownSheets()).toEqual(['Review Actions'])

    act(() => drawer('Review Actions').props.onClose())
    expect(shownSheets()).toEqual([])

    finishClosing('Review Actions')
    expect(shownSheets()).toEqual(['Review Complete'])
  })

  it('a sheet replaced before it was ever shown is never mounted', async () => {
    await mountScreen()
    act(() => {
      controller.openSheet({ kind: 'completion' })
      controller.openSheet({ kind: 'actions' })
    })
    expect(shownSheets()).toEqual(['Review Actions'])

    act(() => {
      controller.openSheet({ kind: 'completion' })
      controller.closeSheet('completion')
    })
    expect(shownSheets()).toEqual([])
    finishClosing('Review Actions')
    expect(mountedDrawers()).toEqual([])
  })

  it('a send list that lands after Send Notes was dismissed does not bring it back', async () => {
    await mountScreen()
    act(() => void controller.openSendSheet())
    expect(shownSheets()).toEqual(['Send Notes'])

    act(() => drawer('Send Notes').props.onClose())
    await answer('session.tabs.list', TABS_REPLY)
    finishClosing('Send Notes')
    expect(mountedDrawers()).toEqual([])

    act(() => controller.openSheet({ kind: 'actions' }))
    expect(shownSheets()).toEqual(['Review Actions'])
  })

  it('Discard keeps its file through the close and discards the file it showed', async () => {
    await mountScreen()
    const target = controller.currentItem!
    act(() => controller.openSheet({ kind: 'discard', target }))
    press(drawer('Discard File'), 'Discard')
    expect(shownSheets()).toEqual([])
    expect(textOf(drawer('Discard File')).join(' ')).toContain(target.filePath)
    expect(replies.has('git.discard')).toBe(true)
  })
})
