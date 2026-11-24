// One of a teammate's chats with a shared agent: the regular phone chat. A message sent while the
// owner's computer is away waits under it, then lands or reads Not sent with Send again. A new chat
// started then is the placeholder its first message waits under, until the host starts it.
import { useEffect, useMemo } from 'react'
import { View } from 'react-native'
import { useLocalSearchParams } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { isSharedBotNewChatId } from '../../../../src/shared/bots/shared-bot-hosts'
import { TransientToast, useTransientToast } from '../../components/feedback/TransientToast'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { useRouteHandoff } from '../../navigation/route-handoff'
import { MobileNativeChatOverlay } from '../../session/native-chat/MobileNativeChatOverlay'
import {
  MobileNativeChatDeliveryContext,
  type MobileNativeChatDeliveryNotice
} from '../../session/native-chat/transcript/notices/mobile-native-chat-delivery'
import { useMobileSessionKeyboardLift } from '../../terminal/session/input-controls/use-mobile-session-keyboard-lift'
import { colors } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { useHostClient } from '../../transport/connection/host-client-hooks'
import { botSessionStart } from '../bot-sheet-operations'
import { mobileBotAvatarSource } from '../host-bot-row-facts'
import { MobileSharedAgentNavBar, MobileSharedAgentUnavailable } from './MobileSharedAgentChrome'
import { sharedAgentChatHref } from './MobileSharedAgentPage'
import { sharedAgentChatTranscriptHeld } from './shared-agent-chat-held'
import { useSharedAgentChat } from './use-shared-agent-chat'
import { useSharedAgentPage } from './use-shared-agent-page'
import { useSharedAgentSendAgain } from './use-shared-agent-views'

const noop = () => {}

export function MobileSharedAgentChat() {
  const t = useMobileTranslation()
  useMobileColorScheme()
  const insets = useSafeAreaInsets()
  const router = useRouteHandoff()
  const params = useLocalSearchParams<{
    hostId: string
    environmentId: string
    sessionId: string
    title?: string
  }>()
  const { hostId, environmentId, sessionId } = params
  const page = useSharedAgentPage(hostId, environmentId)
  const agent = page.kind === 'agent' ? page : null
  const { client: paired, state } = useHostClient(hostId)
  const { message: toast, showToast } = useTransientToast()
  const chat = useSharedAgentChat({
    client: agent?.client ?? null,
    pairedHostClient: paired,
    hostId,
    environmentId,
    sessionId,
    // Until the host lists it, as the desktop's placeholder does.
    agent: agent?.bot?.agent ?? 'claude',
    capabilities: agent?.capabilities ?? null,
    connState: state,
    showToast
  })
  const keyboardLift = useMobileSessionKeyboardLift(insets.bottom)
  const sendAgain = useSharedAgentSendAgain(hostId)
  const held = agent?.view.held
  const ownerName = agent?.view.ownerName ?? ''
  const delivery = useMemo(() => {
    const shown = sharedAgentChatTranscriptHeld(held ?? [], sessionId)
    const notices = new Map<string, MobileNativeChatDeliveryNotice>()
    for (const [id, word] of shown.words) {
      notices.set(
        id,
        word.state === 'waiting'
          ? {
              text: t('chat.sharedHeld.waiting', 'Waiting for {{owner}}’s computer', {
                owner: ownerName
              }),
              waiting: true
            }
          : {
              text: t('chat.sharedHeld.notSent', 'Not sent'),
              waiting: false,
              onSendAgain: async () => {
                const sent = await sendAgain(environmentId, word.clientMessageId)
                if (!sent) {
                  showToast(t('chat.sharedHeld.notHeld', 'Couldn’t send it again'))
                }
                return sent
              }
            }
      )
    }
    return { pending: shown.pending, notices }
  }, [held, sessionId, ownerName, environmentId, sendAgain, showToast, t])
  // A new chat started while the host was away moves to the chat the host starts for it.
  const swap = agent?.live && agent.client && isSharedBotNewChatId(sessionId) ? agent : null
  useEffect(() => {
    if (!swap?.client) {
      return
    }
    void botSessionStart
      .request(swap.client, { botId: swap.view.botId, newChatId: sessionId })
      .then((reply) => botSessionStart.interpret(reply).sessionId)
      .then((started) =>
        router.replace(sharedAgentChatHref(hostId, environmentId, started, params.title))
      )
      .catch(() => {})
    // Once per link coming up.
  }, [swap?.reads])
  const back = () => router.back()
  if (page.kind !== 'agent') {
    return <MobileSharedAgentUnavailable page={page} onBack={back} />
  }
  const { view, bot } = page
  const name = bot?.name ?? view.botName
  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <MobileSharedAgentNavBar
        name={params.title || t('bots.chats.untitled', 'New chat')}
        avatar={mobileBotAvatarSource(bot ?? { id: view.botId, name, avatar: null })}
        subtitle={t('bots.shared.chatOf', '{{name}} · Shared by {{owner}}', {
          name,
          owner: view.ownerName
        })}
        onBack={back}
      />
      <View style={styles.chat}>
        {page.client ? (
          <MobileNativeChatDeliveryContext.Provider value={delivery}>
            <MobileNativeChatOverlay
              controller={chat.controller}
              imageSource={{ client: page.client, worktreeId: chat.worktreeId }}
              worktreePath={null}
              connState={state}
              onOpenFile={noop}
              images={chat.images}
              structuredComposer={chat.structuredComposer}
              onMicPress={undefined}
              micActive={false}
              micStarting={false}
              micProcessing={false}
              dictationMode={undefined}
              onMicPressIn={noop}
              onMicPressOut={noop}
              inputLockReason={state === 'connected' ? null : 'disconnected'}
              sendErrorMessage={chat.sendError.message}
              onClearSendError={chat.sendError.clear}
              sendSurfaceId={chat.scopeKey ?? ''}
              sessionId={sessionId}
              getSendCompletionGeneration={chat.getSendCompletionGeneration}
              keyboardInset={keyboardLift}
              hostName={null}
              linkOpenMode={chat.linkOpenMode}
              onRunInTerminal={noop}
              hostOutage={
                page.live
                  ? null
                  : {
                      text: t(
                        'bots.shared.offline',
                        '{{owner}}’s computer is offline. Messages wait and send when it’s back.',
                        { owner: view.ownerName }
                      )
                    }
              }
            />
          </MobileNativeChatDeliveryContext.Provider>
        ) : null}
      </View>
      <TransientToast message={toast} bottomInset={insets.bottom} />
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  screen: { flex: 1, backgroundColor: colors.bgBase },
  chat: { flex: 1 }
}))
