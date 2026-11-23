// A tool this chat's bot gave itself: whether it is still there and signed in, and Remove. Signing in
// stays on the computer, so a tool that needs it says so instead of offering a button.
import { useCallback, useEffect, useState } from 'react'
import { Text } from 'react-native'
import { Wrench } from 'lucide-react-native'
import type { NativeChatBotCardValues } from '../../../../../../src/shared/native-chat/bot-cards/native-chat-bot-card-kind'
import { botToolAddedCardView } from '../../../../../../src/shared/bots/bot-tool-added-card-view'
import { botToolSubtitle, botToolTitle } from '../../../../../../src/shared/bots/bot-tool-labels'
import type { Translate } from '../../../../i18n/mobile-i18n'
import { useMobileTranslation } from '../../../../i18n/use-mobile-translation'
import { colors, typography } from '../../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../../theme/themed-styles'
import { mobileAutomationRowTime } from '../MobileAutomationRowFrame'
import { scaledType } from '../messages/mobile-native-chat-message-styles'
import { MobileNativeChatNoticePill } from '../notices/MobileNativeChatNoticePill'
import { mobileBotToolAddedSay } from './mobile-bot-card-copy'
import { useMobileBotCardHost } from './mobile-bot-card-host'
import { botToolRemove, botToolsListRead } from './mobile-bot-card-operations'
import { MobileBotCardActions, MobileBotCardFrame, MobileBotCardMeta } from './MobileBotCardFrame'

type OwnTool = { name: string; detail: string; remote: boolean; signIn?: { state: string } }

/** A tool's sign-in on the phone: signed in, or a pointer to the computer. */
export function mobileToolSignInLine(signIn: OwnTool['signIn'], t: Translate): string | null {
  if (!signIn) {
    return null
  }
  return signIn.state === 'signed-in'
    ? t('chat.botCards.toolAdded.signedIn', 'Signed in')
    : t('chat.botCards.toolAdded.signInOnComputer', 'Sign in on your computer')
}

export function MobileBotToolAddedCard({
  added,
  timestamp,
  fontScale
}: {
  added: NativeChatBotCardValues['toolAdded']
  timestamp: number | null
  fontScale: number
}): React.JSX.Element {
  const t = useMobileTranslation()
  const host = useMobileBotCardHost()
  const client = host?.client ?? null
  const { botId, tool } = added
  // The tool as the host has it now: the card's copy is from when it was added. Null until read.
  const [own, setOwn] = useState<readonly OwnTool[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const read = useCallback(async () => {
    if (!client) {
      return
    }
    const tools = botToolsListRead.interpret(await botToolsListRead.request(client, { botId }))
    setOwn(tools.own ?? null)
  }, [client, botId])
  useEffect(() => {
    void read().catch(() => {})
  }, [read])
  const live = own?.find((entry) => entry.name === tool.name)
  const view = botToolAddedCardView(
    own === null ? null : live !== undefined,
    mobileToolSignInLine(live?.signIn, t),
    mobileBotToolAddedSay(t)
  )
  const remove = () => {
    if (!client) {
      return
    }
    setBusy(true)
    setError(null)
    void botToolRemove
      .request(client, { botId, name: tool.name })
      .then((response) => {
        botToolRemove.interpret(response)
        return read()
      })
      .catch((caught: unknown) =>
        setError(caught instanceof Error ? caught.message : String(caught))
      )
      .finally(() => setBusy(false))
  }
  return (
    <MobileBotCardFrame
      avatar={<Wrench size={14} color={colors.textMuted} />}
      heading={mobileBotToolAddedSay(t)('heading')}
      trailing={
        timestamp ? (
          <Text style={[styles.time, scaledType(typography.metaSize, fontScale, 4)]}>
            {mobileAutomationRowTime(timestamp)}
          </Text>
        ) : null
      }
      title={botToolTitle(tool.name)}
      meta={
        <MobileBotCardMeta fontScale={fontScale}>
          {[botToolSubtitle(live ?? tool), view.state].filter(Boolean).join(' · ')}
        </MobileBotCardMeta>
      }
      fontScale={fontScale}
      testID={`bot-tool-added-card:${tool.name}`}
    >
      {error ? (
        <Text style={[styles.error, scaledType(typography.metaSize, fontScale)]}>{error}</Text>
      ) : null}
      {view.present ? (
        <MobileBotCardActions>
          <MobileNativeChatNoticePill
            label={mobileBotToolAddedSay(t)('remove')}
            disabled={busy}
            onPress={remove}
          />
        </MobileBotCardActions>
      ) : null}
    </MobileBotCardFrame>
  )
}

const styles = themedStyleSheet(() => ({
  time: { color: colors.textMuted, marginLeft: 'auto' },
  error: { color: colors.statusRed }
}))
