import { useContext } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../../../src/shared/native-chat/native-chat-types'
import { MobileNativeChatRowOverlaysHost } from './MobileNativeChatRowOverlaysHost'
import {
  MobileNativeChatRowOverlaysContext,
  type MobileNativeChatRowOverlays
} from './mobile-native-chat-row-overlays'
import type { MobileNativeChatConversation } from '../../conversation/use-mobile-native-chat-conversation-state'

vi.mock('react-native', async () => ({
  ...(await import('../../../../test-support/react-native-motion-stub')).reactNativeMotionStub(),
  Image: 'Image',
  Modal: 'Modal',
  Platform: { OS: 'ios' },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  View: 'View',
  StyleSheet: { create: (styles: unknown) => styles }
}))
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 })
}))
vi.mock('lucide-react-native', () => ({ X: 'X' }))
vi.mock('../../../../platform/haptics/haptics', () => ({ triggerMediumImpact: vi.fn() }))
vi.mock('./MobileNativeChatRewindDialog', () => ({ MobileNativeChatRewindDialog: () => null }))
vi.mock('./MobileNativeChatMessageActionsSheet', () => ({
  MobileNativeChatMessageActionsSheet: 'MessageActionsSheet'
}))
vi.mock('./MobileLinkActionSheet', () => ({ MobileLinkActionSheet: 'LinkActionSheet' }))
vi.mock('../../visual/MobileImageViewerActions', () => ({
  MobileImageViewerActions: 'ImageViewerActions'
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

describe("a row's actions sheet", () => {
  function shownAcross(conversations: MobileNativeChatConversation[]): boolean[] {
    const [first, ...rest] = conversations
    act(() => {
      renderer = create(chat(first!))
    })
    act(() => overlays!.openActions(message))
    const shown = () =>
      renderer!.root.findAll((node) => String(node.type) === 'MessageActionsSheet').length === 1
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
