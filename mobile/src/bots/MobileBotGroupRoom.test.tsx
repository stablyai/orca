import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { MobileBotGroupRoom } from './MobileBotGroupRoom'
import { closeMobileNativeChatTabDraft } from '../session/native-chat/composer/drafts/mobile-native-chat-draft-store'

type ComposerProps = {
  value: string
  onChangeText: (text: string) => void
  onSend: (text: string) => Promise<boolean>
}
type Harness = { composer: ComposerProps | null; sends: { text: string }[]; reject: boolean }
const h = vi.hoisted((): Harness => ({ composer: null, sends: [], reject: false }))
vi.mock('react-native', () => ({
  Text: 'Text',
  View: 'View',
  Pressable: 'Pressable',
  StyleSheet: { create: (styles: unknown) => styles },
  Platform: { OS: 'ios' }
}))
vi.mock('lucide-react-native', () => ({
  ChevronLeft: 'Icon',
  Ellipsis: 'Icon',
  ListChecks: 'Icon',
  MessageSquare: 'Icon',
  Plus: 'Icon',
  Users: 'Icon'
}))
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 })
}))
vi.mock('../navigation/route-handoff', () => ({ useRouteHandoff: () => ({ back: () => {} }) }))
vi.mock('../components/host-connection/host-protocol-gates-context', () => ({
  useHostProtocolGates: () => ({ hostCapabilities: [] })
}))
vi.mock('../theme/use-mobile-color-scheme', () => ({ useMobileColorScheme: () => 'dark' }))
vi.mock('../i18n/use-mobile-translation', () => ({
  useMobileTranslation: () => (_key: string, fallback: string) => fallback
}))
vi.mock('./MobileBotGroupTranscript', () => ({
  MobileBotGroupTranscript: ({ children }: { children: unknown }) => children
}))
vi.mock('./MobileBotGroupTurns', () => ({
  MobileBotGroupReader: () => null,
  MobileBotGroupTurn: () => null
}))
vi.mock('./MobileBotGroupPeerRequestLine', () => ({ MobileBotGroupPeerRequestLine: () => null }))
vi.mock('./MobileBotGroupMembers', () => ({ MobileBotGroupMembers: () => null }))
vi.mock('./MobileBotGroupItems', () => ({ MobileBotGroupItems: () => null }))
vi.mock('./MobileBotGroupRepliesSheet', () => ({ MobileBotGroupRepliesSheet: () => null }))
vi.mock('./MobileBotGroupApprovalDock', () => ({ MobileBotGroupApprovalDock: () => null }))
vi.mock('./MobileBotGroupRoomBar', () => ({ MobileBotGroupRoomBar: () => null }))
vi.mock('./MobileBotFaceStack', () => ({ MobileBotFaceStack: () => null }))
vi.mock('../components/sheets/ActionSheetModal', () => ({ ActionSheetModal: () => null }))
vi.mock('../components/nav-bar/NavBar', () => ({ NavBar: () => null }))
vi.mock('../components/nav-bar/NavBarButton', () => ({ NavBarButton: () => null }))
vi.mock('../session/native-chat/status/MobileNativeChatSendErrorBanner', () => ({
  MobileNativeChatSendErrorBanner: () => null
}))
vi.mock('../session/native-chat/input/session-options/MobileNativeChatSessionOptionRows', () => ({
  ModelPill: () => null
}))
vi.mock('../session/native-chat/input/prompts/MobileNativeChatPermission', () => ({
  MobileNativeChatPermission: () => null
}))
vi.mock('../session/native-chat/input/prompts/MobileNativeChatQuestion', () => ({
  MobileNativeChatQuestion: () => null
}))
vi.mock('../session/native-chat/transcript/messages/MobileNativeChatMessage', () => ({
  MobileNativeChatMessage: () => null
}))
vi.mock('../session/native-chat/composer/MobileNativeChatComposer', () => ({
  MobileNativeChatComposer: (props: ComposerProps) => {
    h.composer = props
    return null
  }
}))
vi.mock('./use-mobile-bot-group-composer', () => ({
  useMobileBotGroupComposer: () => ({ recipientId: null, roomMentions: [], audience: 'All bots' })
}))
vi.mock('./use-mobile-bot-group-transcript', () => ({
  useMobileBotGroupTranscript: () => ({
    data: {
      group: { id: 'g', name: 'Room', revision: 1, members: [], replyMode: { kind: 'all' } },
      messages: [],
      hasEarlier: false
    },
    bots: [],
    apply: () => {},
    loadEarlier: () => {}
  })
}))
vi.mock('./bot-group-operations', () => ({
  groupSend: {
    request: async (_client: unknown, input: { messageId: string; text: string }) => {
      h.sends.push(input)
      if (h.reject) {
        throw new Error('Group send refused')
      }
      return { message: { id: input.messageId, text: input.text } }
    },
    interpret: (reply: unknown) => reply
  },
  groupStop: {},
  groupUpdate: {}
}))

let view: ReactTestRenderer | undefined
async function mount(): Promise<void> {
  await act(async () => {
    view = create(
      createElement(MobileBotGroupRoom, {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every group operation is mocked above, so the room never reaches the client.
        client: {} as never,
        groupId: 'g',
        hostId: 'host',
        hostName: 'Studio Mac',
        visible: true
      })
    )
  })
}
function composer(): ComposerProps {
  return h.composer!
}
afterEach(async () => {
  await act(async () => view?.unmount())
  h.sends.length = 0
  h.reject = false
  closeMobileNativeChatTabDraft('group:host:g')
})

it('empties the composer once a group post is sent', async () => {
  await mount()
  act(() => composer().onChangeText('First post'))
  await act(async () => {
    expect(await composer().onSend('First post')).toBe(true)
  })
  expect(h.sends.map((send) => send.text)).toEqual(['First post'])
  expect(composer().value).toBe('')
})

it('hands a refused post back to the composer', async () => {
  h.reject = true
  await mount()
  act(() => composer().onChangeText('Refused post'))
  await act(async () => {
    expect(await composer().onSend('Refused post')).toBe(false)
  })
  expect(composer().value).toBe('Refused post')
})

it('keeps an unsent group draft across leaving and reopening the room', async () => {
  await mount()
  act(() => composer().onChangeText('Unsent thought'))
  await act(async () => view?.unmount())
  await mount()
  expect(composer().value).toBe('Unsent thought')
})
