import { createElement, Fragment, type ReactNode } from 'react'
import { vi } from 'vitest'
import type { NativeChatMessage } from '../../../../src/shared/native-chat/native-chat-types'

const { viewRenders, translate } = vi.hoisted(() => ({
  viewRenders: vi.fn(() => ({ bottom: 0 })),
  translate: (_key: string, fallback: string) => fallback
}))
export { viewRenders }

vi.mock('react-native', () => ({ View: 'div', Text: 'span', Pressable: 'button' }))
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: viewRenders }))
vi.mock('react-native-gesture-handler', () => ({ GestureHandlerRootView: 'div' }))
vi.mock('lucide-react-native', () => ({
  ArrowUpRight: 'span',
  ShieldCheck: 'span',
  ShieldMinus: 'span',
  ShieldQuestion: 'span',
  ShieldX: 'span'
}))

vi.mock('./transcript/agent-messages/MobileWaitingAgentMailRows', () => ({
  mobileWaitingAgentMailRows: () => null
}))
vi.mock('./MobileBotFirstScreen', () => ({
  MobileBotFirstScreen: () => null,
  useMobileBotFirstScreen: () => null
}))
vi.mock('./transcript/bot-cards/mobile-native-chat-bot-cards', () => ({
  mobileNativeChatOtherBotCard: () => null
}))
vi.mock('./transcript/viewport/use-mobile-native-chat-item-navigation', () => ({
  useMobileNativeChatItemNavigation: () => null
}))
vi.mock('../../components/feedback/MobileStateView', () => ({
  MobileStateView: () => null
}))
vi.mock('./status/MobileNativeChatSendErrorBanner', () => ({
  MobileNativeChatSendErrorBanner: () => null
}))
vi.mock('./composer/field/MobileNativeChatInputLockStatus', () => ({
  MobileNativeChatInputLockStatus: () => null
}))
vi.mock('./composer/menus/MobileNativeChatComposerMenuHost', () => ({
  MobileNativeChatComposerMenuHost: 'div'
}))
vi.mock('./transcript/viewport/MobileNativeChatEmptyStateView', () => ({
  MobileNativeChatEmptyStateView: () => null
}))
vi.mock('./transcript/viewport/mobile-native-chat-pinch-zoom', () => ({
  useMobileNativeChatPinchGesture: () => ({ fontScale: 1, pinchGesture: null })
}))
vi.mock('./preferences/native-chat-text-settings', () => ({
  useNativeChatTextSettings: () => ({ font: 'default', lineSpacing: 1 })
}))
vi.mock('./transcript/viewport/use-mobile-native-chat-tail-follow', () => ({
  useMobileNativeChatTailFollow: () => ({ viewport: null })
}))
vi.mock('./composer/field/use-mobile-native-chat-input-lease', () => ({
  mobileNativeChatComposerPlaceholder: () => undefined
}))
vi.mock('./transcript/messages/MobileNativeChatLiveLine', () => ({
  MobileNativeChatLiveLine: () => createElement('span', null, 'Working')
}))
vi.mock('./transcript/messages/MobileNativeChatAwaitingInputRow', () => ({
  MobileNativeChatAwaitingInputRow: () => null
}))
vi.mock('./lower-region/MobileNativeChatFloatingControls', () => ({
  MobileNativeChatFloatingControls: () => null
}))
vi.mock('./composer/MobileNativeChatDraftComposer', () => ({
  MobileNativeChatDraftComposer: () => null
}))
vi.mock('./input/prompts/MobileNativeChatPromptCard', () => ({
  MobileNativeChatPromptCard: () => null
}))
vi.mock('./input/prompts/MobileNativeChatWorkerApproval', () => ({
  workerOpener: () => null,
  useMobileNativeChatWorkerApprovalSlot: () => ({ card: null, strip: null })
}))
vi.mock('./input/prompts/use-mobile-native-chat-prompt-input-owner', () => ({
  useMobileNativeChatPromptInputOwner: () => false
}))
vi.mock('./composer/menus/use-mobile-native-chat-composer-tray', () => ({
  NO_COMPOSER_TRAY: { content: null }
}))
vi.mock('./transcript/viewport/MobileNativeChatScrollRootsBoundary', () => ({
  MobileNativeChatScrollRootsBoundary: 'div'
}))
vi.mock('./lower-region/MobileNativeChatLowerRegion', () => ({
  MobileNativeChatLowerRegion: 'div'
}))
vi.mock('./input/prompts/MobileNativeChatPromptStrip', () => ({
  MobileNativeChatPromptStrip: () => null
}))
vi.mock('./input/queued-messages/MobileNativeChatOfflineQueue', () => ({
  MobileNativeChatOfflineQueue: () => null
}))
vi.mock('./composer/delivery/use-mobile-native-chat-offline-sends', () => ({
  useMobileNativeChatOfflineQueue: () => ({ composerLock: {} })
}))
vi.mock('./transcript/messages/MobileNativeChatEventRow', () => ({
  MobileNativeChatEventName: () => null,
  MobileNativeChatEventRow: () => null
}))
vi.mock('./transcript/messages/use-mobile-message-time', () => ({
  useMobileMessageTime: () => ({ label: () => '12:00', full: () => '12:00' })
}))
vi.mock('../../i18n/use-mobile-translation', () => ({
  useMobileTranslation: () => translate
}))
vi.mock('../../theme/use-mobile-color-scheme', () => ({
  useMobileColorScheme: () => undefined
}))
vi.mock('../../theme/mobile-theme', () => ({
  colors: {},
  spacing: {},
  typography: { metaSize: 12, monoSize: 12 },
  pressedStyle: {}
}))
vi.mock('../../theme/themed-styles', () => ({
  themedStyleSheet: () => ({})
}))
vi.mock('./transcript/messages/mobile-native-chat-message-styles', () => ({
  styles: {},
  scaledType: () => ({}),
  MONO_SIZE: 12
}))
// Draw one virtualized row plus the footer while the full list goes through the view's placement code.
vi.mock('./transcript/MobileNativeChatRowList', () => ({
  MobileNativeChatRowList: ({
    rows,
    renderItem,
    footer
  }: {
    rows: readonly NativeChatMessage[]
    renderItem: (row: { item: NativeChatMessage; index: number }) => ReactNode
    footer: ReactNode
  }) => {
    const index = rows.findIndex((row) => row.id === 'orca:opener')
    return createElement(
      Fragment,
      null,
      index === -1 ? null : renderItem({ item: rows[index]!, index }),
      footer
    )
  }
}))
vi.mock('./transcript/projection/MobileNativeChatRowItemSource', async () => {
  const { MobileNativeChatMessageTime } = await vi.importActual<{
    MobileNativeChatMessageTime: (props: {
      submissionItemId: string
      timestamp: number | null
      fontScale: number
    }) => ReactNode
  }>('./transcript/messages/MobileNativeChatMessageTime')
  return {
    MobileNativeChatRow: ({
      message,
      fontScale
    }: {
      message: NativeChatMessage
      fontScale: number
    }) =>
      createElement(MobileNativeChatMessageTime, {
        submissionItemId: message.id,
        timestamp: message.timestamp,
        fontScale
      })
  }
})

const { placement } = vi.hoisted(() => ({ placement: vi.fn() }))
export { placement }
vi.mock(
  '../../../../src/shared/native-chat/transcript/native-chat-timed-row-anchors',
  async (actual) => {
    const module =
      await actual<
        typeof import('../../../../src/shared/native-chat/transcript/native-chat-timed-row-anchors')
      >()
    return {
      ...module,
      anchorNativeChatTimedRows: (...args: Parameters<typeof module.anchorNativeChatTimedRows>) => {
        const anchors = module.anchorNativeChatTimedRows(...args)
        placement(anchors)
        return anchors
      }
    }
  }
)
