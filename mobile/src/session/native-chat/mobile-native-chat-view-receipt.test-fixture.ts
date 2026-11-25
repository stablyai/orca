import { createElement, Fragment, type ReactNode } from 'react'
import type { ImageStyle, TextStyle, ViewStyle } from 'react-native'
import { vi } from 'vitest'
import type { NativeChatMessage } from '../../../../src/shared/native-chat/native-chat-types'
import { useStructuredAgentDisplayedSendPending } from '../../../../src/shared/agent-session/view/use-structured-agent-sending'

const { viewRenders, listRenders, messageRenders, activityRenders, translate } = vi.hoisted(() => ({
  viewRenders: vi.fn(() => ({ bottom: 0 })),
  listRenders: vi.fn(),
  messageRenders: vi.fn(),
  activityRenders: vi.fn(),
  translate: (_key: string, fallback: string) => fallback
}))
export { viewRenders, listRenders, messageRenders, activityRenders }

vi.mock('react-native', () => ({
  View: 'div',
  Text: 'span',
  Pressable: 'button',
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) },
  Platform: {
    OS: 'ios',
    select: (options: { ios?: unknown; default?: unknown }) => options.ios ?? options.default
  },
  StyleSheet: { create: (styles: Record<string, ImageStyle | TextStyle | ViewStyle>) => styles },
  // Mount two real rows and the footer without the native virtualizer.
  FlatList: ({
    data,
    renderItem,
    ListFooterComponent
  }: {
    data: readonly NativeChatMessage[]
    renderItem: (row: { item: NativeChatMessage; index: number }) => ReactNode
    ListFooterComponent?: ReactNode
  }) => {
    listRenders()
    return createElement(
      Fragment,
      null,
      data
        .slice(0, 2)
        .map((item, index) =>
          createElement(Fragment, { key: item.id }, renderItem({ item, index }))
        ),
      ListFooterComponent
    )
  }
}))
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: viewRenders }))
vi.mock('react-native-gesture-handler', () => ({ GestureHandlerRootView: 'div' }))
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
  MobileNativeChatPinchZoom: ({ children }: { children: ReactNode }) => children,
  useMobileNativeChatPinchGesture: () => ({ fontScale: 1, pinchGesture: null })
}))
vi.mock('./preferences/native-chat-text-settings', () => ({
  useNativeChatTextSettings: () => ({ font: 'default', lineSpacing: 1 }),
  useNativeChatProseText: () => ({ textScale: 1, lineSpacing: 1 })
}))
vi.mock('./transcript/viewport/use-mobile-native-chat-tail-follow', () => ({
  mobileNativeChatRowAnchor: () => undefined,
  useMobileNativeChatTailFollow: () => ({ viewport: null })
}))
vi.mock('./composer/field/use-mobile-native-chat-input-lease', () => ({
  mobileNativeChatComposerPlaceholder: () => undefined
}))
vi.mock('./transcript/messages/MobileNativeChatLiveLine', () => ({
  MobileNativeChatLiveLine: ({ line }: { line: { stopping: boolean } }) => {
    activityRenders(line.stopping, useStructuredAgentDisplayedSendPending())
    return createElement('span', null, line.stopping ? 'Stopping…' : 'Working')
  }
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
vi.mock('./transcript/messages/mobile-native-chat-message-styles', () => ({
  styles: {},
  scaledType: () => ({}),
  MONO_SIZE: 12
}))
vi.mock('./transcript/viewport/MobileNativeChatPageList', () => ({
  MobileNativeChatPageList: () => null
}))
vi.mock('./transcript/message-content/MobileNativeChatFullContent', () => ({
  useMobileNativeChatFullMessage: (message: NativeChatMessage) => {
    messageRenders(message.id)
    return { shown: message, showFull: null, recovery: null }
  }
}))
vi.mock('./transcript/message-content/MobileNativeChatMarkdown', () => ({
  MobileNativeChatMarkdown: () => null
}))

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
