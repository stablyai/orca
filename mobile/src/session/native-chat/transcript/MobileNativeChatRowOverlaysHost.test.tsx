import { useContext } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../../src/shared/native-chat-types'
import { MobileNativeChatRowOverlaysHost } from './MobileNativeChatRowOverlaysHost'
import {
  MobileNativeChatRowOverlaysContext,
  type MobileNativeChatRowOverlays
} from './mobile-native-chat-row-overlays'
import type { MobileNativeChatConversation } from '../../use-mobile-native-chat-conversation-state'
import { stubRpcClient } from '../../../transport/rpc-client-test-stub'

vi.mock('react-native', () => ({
  Image: 'Image',
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

it('closes a host image when its owning client changes and never reopens it on return', () => {
  const first = { client: stubRpcClient(), worktreeId: 'w1' }
  const second = { client: stubRpcClient(), worktreeId: 'w1' }
  const render = (imageSource: typeof first) => (
    <MobileNativeChatRowOverlaysHost
      conversation={{ surfaceId: 'tab-a', sessionId: 's1' }}
      imageSource={imageSource}
    >
      <Row />
    </MobileNativeChatRowOverlaysHost>
  )
  act(() => {
    renderer = create(render(first))
  })
  act(() => overlays?.openImage({ uri: 'data:image/png;base64,AA==', label: 'Host image' }))
  const images = () => renderer!.root.findAll((node) => String(node.type) === 'Modal')
  expect(images()).toHaveLength(1)
  act(() => renderer!.update(render(second)))
  expect(images()).toHaveLength(0)
  act(() => renderer!.update(render(first)))
  expect(images()).toHaveLength(0)
})

describe.each([
  ['picture', 'Modal', () => overlays!.openImage({ uri: 'file:///a.jpg', label: 'a photo' })],
  ['actions sheet', 'MessageActionsSheet', () => overlays!.openActions(message)]
])("a row's %s", (_, type, open) => {
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
