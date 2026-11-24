// A shared agent's page on a teammate's phone: New chat, then their own chats with it. It opens while
// the owner's computer is away too, saying so; a message sent then waits for it.
import { useCallback, useMemo } from 'react'
import { Pressable, ScrollView, Text, View } from 'react-native'
import { useLocalSearchParams } from 'expo-router'
import { SquarePen } from 'lucide-react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { useRouteHandoff } from '../../navigation/route-handoff'
import { colors, spacing } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { botSessionStart } from '../bot-sheet-operations'
import { mobileBotAvatarSource } from '../host-bot-row-facts'
import { hostBotsKey } from '../host-bots-read'
import { MobileBotChatTree, type BotChatTreeNote } from '../MobileBotChatTree'
import { usePhoneBotChatTree } from '../use-phone-bot-chat-tree'
import {
  MobileSharedAgentNavBar,
  MobileSharedAgentOfflineLine,
  MobileSharedAgentUnavailable
} from './MobileSharedAgentChrome'
import { MobileNativeChatDeliveryNotice } from '../../session/native-chat/transcript/notices/MobileNativeChatDeliveryNotice'
import { sharedAgentChatHeld, sharedAgentChats } from './shared-agent-chat-held'
import { useSharedAgentPage } from './use-shared-agent-page'
import type { BotChatSearchAsk } from '../../../../src/shared/bots/use-bot-chat-search'

export function sharedAgentChatHref(
  hostId: string,
  environmentId: string,
  sessionId: string,
  title?: string
) {
  const path = `/h/${encodeURIComponent(hostId)}/shared/${encodeURIComponent(environmentId)}/${encodeURIComponent(sessionId)}`
  return title ? `${path}?title=${encodeURIComponent(title)}` : path
}

export function MobileSharedAgentPage() {
  const t = useMobileTranslation()
  useMobileColorScheme()
  const insets = useSafeAreaInsets()
  const router = useRouteHandoff()
  const params = useLocalSearchParams<{ hostId: string; environmentId: string }>()
  const page = useSharedAgentPage(params.hostId, params.environmentId)
  const agent = page.kind === 'agent' ? page : null
  const tree = usePhoneBotChatTree({
    client: agent?.client ?? null,
    botId: agent?.view.botId ?? '',
    showing: agent?.live === true,
    reads: agent?.reads ?? 0
  })
  const held = agent?.view.held
  const chats = useMemo(
    () => sharedAgentChats(tree.kind === 'tree' ? tree.chats : [], held ?? []),
    [tree, held]
  )
  const note = useCallback<BotChatTreeNote>(
    (chat) => {
      const word = sharedAgentChatHeld(held ?? [], chat.chatId)
      return word
        ? {
            line: word.text,
            aside: (
              <MobileNativeChatDeliveryNotice
                notice={
                  word.state === 'waiting'
                    ? { text: t('chat.sharedHeld.waitingShort', 'Waiting'), waiting: true }
                    : { text: t('chat.sharedHeld.notSent', 'Not sent'), waiting: false }
                }
              />
            )
          }
        : null
    },
    [held, t]
  )
  const back = () => router.back()
  const open = (sessionId: string, title?: string) =>
    router.push(sharedAgentChatHref(params.hostId, params.environmentId, sessionId, title))
  const startChat = async () => {
    if (!agent?.client) {
      return
    }
    const { sessionId } = botSessionStart.interpret(
      await botSessionStart.request(agent.client, { botId: agent.view.botId })
    )
    open(sessionId)
  }
  if (page.kind !== 'agent') {
    return <MobileSharedAgentUnavailable page={page} onBack={back} />
  }
  const { view, bot } = page
  const name = bot?.name ?? view.botName
  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <MobileSharedAgentNavBar
        name={name}
        avatar={mobileBotAvatarSource(bot ?? { id: view.botId, name, avatar: null })}
        subtitle={t('bots.share.sharedBy', 'Shared by {{name}}', { name: view.ownerName })}
        onBack={back}
      />
      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + spacing.xl }}>
        {page.live ? null : <MobileSharedAgentOfflineLine ownerName={view.ownerName} />}
        <Pressable
          accessibilityRole="button"
          style={styles.newChat}
          onPress={() => void startChat().catch(() => {})}
        >
          <SquarePen size={18} color={colors.accentBlue} />
          <Text style={styles.newChatText}>{t('bots.shared.newChat', 'New chat')}</Text>
        </Pressable>
        {chats.length > 0 ? (
          <MobileBotChatTree
            bot={{ id: view.botId, name }}
            hostKey={hostBotsKey(params.hostId, `runtime:${view.environmentId}`)}
            chats={chats}
            loadMore={tree.kind === 'tree' ? tree.loadMore : () => {}}
            search={tree.kind === 'tree' ? tree.search : NO_SEARCH}
            actions={{ openChat: (chat) => open(chat.chatId, chat.title), openWorker: () => {} }}
            heading={t('bots.shared.yourChats', 'Your chats')}
            note={note}
          />
        ) : null}
      </ScrollView>
    </View>
  )
}

// Their list has no search field (see `heading`), so nothing asks it.
const NO_SEARCH: BotChatSearchAsk = async () => ({ chats: [], matches: [], more: 0 })

const styles = themedStyleSheet(() => ({
  screen: { flex: 1, backgroundColor: colors.bgBase },
  newChat: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    marginHorizontal: spacing.lg,
    marginVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: 12,
    backgroundColor: colors.bgPanel
  },
  newChatText: { fontSize: 16, color: colors.accentBlue }
}))
