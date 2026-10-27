import { resolveMobileNativeChatRowProps } from './use-mobile-native-chat-row-props'
import { createElement, type ReactElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, vi } from 'vitest'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import { MobileNativeChatView } from './MobileNativeChatView'
import { setMobileNativeChatDraftText } from './native-chat/composer/mobile-native-chat-draft-store'
import {
  scrollToEnd,
  scrollToOffset,
  pageScroller
} from './MobileNativeChatView.render-stubs.test-fixture'

vi.mock('../components/DragReorderList', () => ({ DragReorderList: 'DragReorderList' }))
vi.mock('react-native-reanimated', async () => {
  const { useRef } = await import('react')
  return {
    default: { ScrollView: 'ScrollView' },
    useAnimatedRef: () => useRef(null),
    useSharedValue: (value: unknown) => useRef({ value }).current
  }
})

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
  olderPages?: Parameters<typeof MobileNativeChatView>[0]['olderPages']
  onLoadEarlier?: () => void
  status?: Parameters<typeof MobileNativeChatView>[0]['status']
  error?: string
  readFailedFinally?: boolean
  actionablePromptIds?: readonly string[]
}

export function assistantTurn(id: string, text: string): NativeChatMessage {
  return { id, role: 'assistant', blocks: [{ type: 'text', text }], timestamp: 0, source: 'hook' }
}

const DRAFT_KEY = 'draft-a'

function chatViewElement({
  composerText = '',
  ...overrides
}: Overrides): ReturnType<typeof createElement> {
  setMobileNativeChatDraftText(DRAFT_KEY, composerText)
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
    draftKey: DRAFT_KEY,
    onComposerTextChange: vi.fn(),
    ...overrides
  })
}

let renderer: ReactTestRenderer | null = null

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
  const row = listNode.props.renderItem({ item: data[index], index })
  const resolved = resolveMobileNativeChatRowProps(index, data[index]!, row.props.lookups)
  return createElement('Row', { ...row.props, ...resolved })
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

export {
  scrollToEnd,
  scrollToOffset,
  platform,
  pageScroller
} from './MobileNativeChatView.render-stubs.test-fixture'
