import { useContext } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import { MobileNativeChatRowOverlaysHost } from './MobileNativeChatRowOverlaysHost'
import {
  MobileNativeChatRowOverlaysContext,
  type MobileNativeChatRowOverlays
} from './mobile-native-chat-row-overlays'
import type { MobileNativeChatConversation } from './use-mobile-native-chat-conversation-state'

vi.mock('react-native-gesture-handler', () => ({
  GestureHandlerRootView: 'View',
  GestureDetector: ({ children }: { children: unknown }) => children,
  Gesture: { Native: () => ({}) }
}))
vi.mock('./MobileNativeChatZoomableImagePage', () => ({
  MobileNativeChatZoomableImagePage: 'AndroidImagePage'
}))
vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  Image: 'Image',
  Text: 'Text',
  FlatList: 'FlatList',
  useWindowDimensions: () => ({ width: 390, height: 844 }),
  Modal: 'Modal',
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  View: 'View',
  StyleSheet: { create: (styles: unknown) => styles }
}))
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 })
}))
vi.mock('lucide-react-native', () => ({ X: 'X' }))
vi.mock('./MobileNativeChatMessageActionsSheet', () => ({
  MobileNativeChatMessageActionsSheet: 'MessageActionsSheet'
}))

let overlays: MobileNativeChatRowOverlays | null = null
function Row(): null {
  overlays = useContext(MobileNativeChatRowOverlaysContext)
  return null
}
const chat = (conversation: MobileNativeChatConversation) => (
  <MobileNativeChatRowOverlaysHost conversation={conversation}>
    <Row />
  </MobileNativeChatRowOverlaysHost>
)
const message: NativeChatMessage = {
  id: 'a1',
  role: 'assistant',
  blocks: [{ type: 'text', text: 'Done.' }],
  timestamp: null,
  source: 'transcript'
}

let renderer: ReactTestRenderer | null = null
afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
})

describe.each([
  ['picture', 'Modal', () => overlays!.openImage({ uri: 'file:///a.jpg', label: 'a photo' })],
  ['actions sheet', 'MessageActionsSheet', () => overlays!.openActions(message)]
])("a row's %s", (_, type, open) => {
  /** Opens it in the first conversation, then moves through the rest; one shown flag each. */
  function shownAcross(conversations: MobileNativeChatConversation[]): boolean[] {
    const [first, ...rest] = conversations
    act(() => {
      renderer = create(chat(first!))
    })
    act(open)
    const shown = () => renderer!.root.findAll((node) => String(node.type) === type).length === 1
    return [shown()].concat(
      rest.map((conversation) => {
        act(() => renderer!.update(chat(conversation)))
        return shown()
      })
    )
  }

  it('closes when a notification switches the tab, and does not reopen', () => {
    expect(
      shownAcross([
        { surfaceId: 'tab-a', sessionId: 's1' },
        { surfaceId: 'tab-b', sessionId: 's1' },
        { surfaceId: 'tab-a', sessionId: 's1' }
      ])
    ).toEqual([true, false, false])
  })

  it("closes when the tab's agent session is replaced", () => {
    expect(
      shownAcross([
        { surfaceId: 'tab-a', sessionId: 's1' },
        { surfaceId: 'tab-a', sessionId: 's2' }
      ])
    ).toEqual([true, false])
  })

  it("stays open when the tab's first session id arrives, then closes on a replacement", () => {
    expect(
      shownAcross([
        { surfaceId: 'tab-a', sessionId: null },
        { surfaceId: 'tab-a', sessionId: 's1' },
        { surfaceId: 'tab-a', sessionId: 's2' }
      ])
    ).toEqual([true, true, false])
  })
})

it('opens the selected gallery image and retains every neighboring image', () => {
  const images = Array.from({ length: 5 }, (_, index) => ({
    type: 'image-ref' as const,
    url: `file:///${index}.jpg`,
    alt: `Photo ${index + 1}`
  }))
  act(() => {
    renderer = create(chat({ surfaceId: 'gallery', sessionId: 's1' }))
  })
  act(() =>
    overlays!.openImage({
      uri: 'file:///2.jpg',
      label: 'Photo 3',
      gallery: { images, initialIndex: 2 }
    })
  )
  const list = renderer!.root.find((node) => String(node.type) === 'FlatList')
  expect(list.props.data).toBe(images)
  expect(list.props.initialScrollIndex).toBe(2)
  act(() => list.props.onScroll({ nativeEvent: { contentOffset: { x: 390 * 4 } } }))
  expect(
    renderer!.root
      .findAll((node) => String(node.type) === 'Text')
      .some((node) => node.props.children.join('') === '5 / 5')
  ).toBe(true)
})
