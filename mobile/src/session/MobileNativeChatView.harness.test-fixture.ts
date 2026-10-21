import { createElement, type ReactElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, vi } from 'vitest'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import { MobileNativeChatView } from './MobileNativeChatView'
import {
  scrollToEnd,
  scrollToOffset,
  platform,
  pageScroller
} from './MobileNativeChatView.render-stubs.test-fixture'

export type Overrides = {
  messages?: Parameters<typeof MobileNativeChatView>[0]['messages']
  folded?: Parameters<typeof MobileNativeChatView>[0]['folded']
  streaming?: string | null
  sendErrorMessage?: string | null
  onClearSendError?: () => void
  inputLockReason?: 'disconnected' | 'waiting' | null
  composerText?: string
  onSend?: (text: string) => Promise<boolean>
  pending?: Parameters<typeof MobileNativeChatView>[0]['pending']
  structuredActivityUi?: boolean
  turnIndicator?: Parameters<typeof MobileNativeChatView>[0]['turnIndicator']
  agentWorking?: boolean
  canStop?: boolean
  ask?: Parameters<typeof MobileNativeChatView>[0]['ask']
  question?: Parameters<typeof MobileNativeChatView>[0]['question']
  permission?: Parameters<typeof MobileNativeChatView>[0]['permission']
  sendSurfaceId?: string
  keyboardInset?: number
  hasMore?: boolean
  onLoadEarlier?: () => void
  status?: Parameters<typeof MobileNativeChatView>[0]['status']
  error?: string
  readFailedFinally?: boolean
  actionablePromptIds?: readonly string[]
}

export function assistantTurn(id: string, text: string): NativeChatMessage {
  return { id, role: 'assistant', blocks: [{ type: 'text', text }], timestamp: 0, source: 'hook' }
}

function chatViewElement(overrides: Overrides): ReturnType<typeof createElement> {
  return createElement(MobileNativeChatView, {
    messages: [],
    folded: [],
    status: 'ready',
    streaming: null,
    onSend: vi.fn().mockResolvedValue(true),
    sendSurfaceId: 'tab-a',
    getSendCompletionGeneration: () => 0,
    getComposerEditGeneration: () => 0,
    pending: [],
    composerText: '',
    onComposerTextChange: vi.fn(),
    ...overrides
  })
}

let renderer: ReactTestRenderer | null = null

// Stubs the frame clock and tears down the mounted view; call once at the top of a test file.
export function installChatViewHooks(): void {
  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
      setTimeout(() => callback(0), 0)
    )
    vi.stubGlobal('cancelAnimationFrame', (handle: ReturnType<typeof setTimeout>) =>
      clearTimeout(handle)
    )
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    scrollToEnd.mockReset()
    scrollToOffset.mockReset()
    Object.assign(pageScroller, { scrollTop: 0, scrollHeight: 0, clientHeight: 500 })
    pageScroller.style.overflowAnchor = ''
    vi.unstubAllGlobals()
  })
}

export function root(): ReactTestInstance {
  return renderer!.root
}

// Mocked react-native components are string tags that ReactTestInstance's ElementType omits.
export function hostType(node: ReactTestInstance): unknown {
  return node.type
}

export async function render(overrides: Overrides = {}): Promise<void> {
  await act(async () => {
    renderer = create(chatViewElement(overrides))
  })
}

export async function update(overrides: Overrides = {}): Promise<void> {
  await act(async () => {
    renderer?.update(chatViewElement(overrides))
  })
}

// Ids of the rows the list is currently rendering.
export function listIds(): string[] {
  return (list().props.data as { id: string }[]).map((row) => row.id)
}

export function list(): ReactTestInstance {
  return renderer!.root.find((node) => hostType(node) === 'FlatList')
}

export function renderedRow(id: string): ReactElement<Record<string, unknown>> {
  const listNode = list()
  const data = listNode.props.data as NativeChatMessage[]
  const index = data.findIndex((row) => row.id === id)
  return listNode.props.renderItem({ item: data[index], index })
}

export function banners(): ReactTestInstance[] {
  return renderer!.root.findAll((node) => node.props.accessibilityRole === 'alert')
}

export function composer(): ReactTestInstance {
  return renderer!.root.find((node) => hostType(node) === 'Composer')
}

export function bannerText(): string {
  const [alert, ...rest] = banners()
  expect(rest).toHaveLength(0)
  return alert
    .findAll((node) => hostType(node) === 'Text')
    .map((node) => node.props.children)
    .join('')
}

export async function pressSend(): Promise<void> {
  const composer = renderer!.root.find((node) => hostType(node) === 'Composer')
  await act(async () => {
    await composer.props.onPress()
  })
}

/** What the list reports from a scroll, drag or momentum event, in a 500-tall viewport. */
export function scrollEvent(y: number, contentHeight: number) {
  return {
    nativeEvent: {
      contentOffset: { y },
      contentSize: { height: contentHeight },
      layoutMeasurement: { height: 500 }
    }
  }
}

export async function scrollAwayFromTail(): Promise<void> {
  await act(async () => {
    list().props.onScrollBeginDrag?.({})
    list().props.onScroll({
      nativeEvent: {
        contentOffset: { y: 200 },
        contentSize: { height: 1_200 },
        layoutMeasurement: { height: 500 }
      }
    })
  })
}

export { scrollToEnd, scrollToOffset, platform, pageScroller }
