// A tool this chat's bot gave itself: whether it is still there, its sign-in, and Remove. Signing in
// opens the app's page in the phone's browser and finishes from the address it lands on, pasted here.
import { useCallback, useEffect, useState } from 'react'
import { Text, View } from 'react-native'
import { ExternalLink, Wrench } from 'lucide-react-native'
import type { NativeChatBotCardValues } from '../../../../../../src/shared/native-chat/bot-cards/native-chat-bot-card-kind'
import { botToolAddedCardView } from '../../../../../../src/shared/bots/bot-tool-added-card-view'
import { botToolSubtitle, botToolTitle } from '../../../../../../src/shared/bots/bot-tool-labels'
import { botToolSignInFace } from '../../../../../../src/shared/bots/bot-tool-sign-in-face'
import {
  botToolsListRead,
  botToolRemove,
  type PhoneOwnTool
} from '../../../../bots/tools/bot-tool-operations'
import { botToolSignInActionLabel, botToolSignInLine } from '../../../../bots/tools/bot-tool-words'
import { useBotToolPhoneSignIn } from '../../../../bots/tools/use-bot-tool-phone-sign-in'
import { TextField } from '../../../../components/composer-input/TextField'
import { useMobileTranslation } from '../../../../i18n/use-mobile-translation'
import { colors, spacing, typography } from '../../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../../theme/themed-styles'
import { mobileAutomationRowTime } from '../MobileAutomationRowFrame'
import { scaledType } from '../messages/mobile-native-chat-message-styles'
import { MobileNativeChatNoticePill } from '../notices/MobileNativeChatNoticePill'
import { mobileBotToolAddedSay } from './mobile-bot-card-copy'
import { useMobileBotCardHost } from './mobile-bot-card-host'
import { MobileBotCardActions, MobileBotCardFrame, MobileBotCardMeta } from './MobileBotCardFrame'

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
  const hostName = host?.hostLabel ?? ''
  const { botId, tool } = added
  // The tool as the host has it now: the card's copy is from when it was added. Null until read.
  const [own, setOwn] = useState<readonly PhoneOwnTool[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [address, setAddress] = useState('')
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
  const signIn = useBotToolPhoneSignIn({
    client,
    botId,
    tool: live ?? tool,
    hostName,
    onSignedIn: () => {
      setAddress('')
      void read().catch(() => {})
    }
  })
  const attempt = signIn.attempt
  const face = live
    ? botToolSignInFace(live, undefined, attempt !== null, signIn.failure, attempt?.finishing)
    : null
  const view = botToolAddedCardView(
    own === null ? null : live !== undefined,
    botToolSignInLine(face, t, hostName),
    mobileBotToolAddedSay(t)
  )
  const action = botToolSignInActionLabel(face, t)
  const pasted = address.trim()
  const finish = () => {
    if (pasted) {
      signIn.finish(pasted)
    }
  }
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
  const shownError = error ?? signIn.error
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
      {view.present && attempt ? (
        <View style={styles.paste}>
          <Text style={[styles.hint, scaledType(typography.metaSize, fontScale, 4)]}>
            {t(
              'bots.tools.signIn.pasteLanded',
              'After you sign in, paste the address you landed on.'
            )}
          </Text>
          <TextField
            value={address}
            onChangeText={setAddress}
            monospace
            placeholder={t('bots.tools.signIn.pastePlaceholder', 'Paste the address')}
            accessibilityLabel={t('bots.tools.address', 'Address')}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            returnKeyType="done"
            editable={!attempt.finishing}
            onSubmitEditing={finish}
          />
        </View>
      ) : null}
      {shownError ? (
        <Text style={[styles.error, scaledType(typography.metaSize, fontScale)]}>{shownError}</Text>
      ) : null}
      {view.present && attempt ? (
        <MobileBotCardActions>
          <MobileNativeChatNoticePill
            label={t('bots.tools.signIn.finish', 'Finish')}
            primary
            disabled={!pasted || attempt.finishing}
            onPress={finish}
          />
          {attempt.url ? (
            <MobileNativeChatNoticePill
              label={t('bots.tools.signIn.openAgain', 'Open page again')}
              Icon={ExternalLink}
              onPress={signIn.openAgain}
            />
          ) : null}
          <MobileNativeChatNoticePill
            label={t('common.cancel', 'Cancel')}
            style={styles.end}
            onPress={signIn.cancel}
          />
        </MobileBotCardActions>
      ) : view.present ? (
        <MobileBotCardActions>
          {action ? (
            <MobileNativeChatNoticePill
              label={action}
              primary
              disabled={busy || signIn.starting}
              onPress={signIn.start}
            />
          ) : null}
          <MobileNativeChatNoticePill
            label={mobileBotToolAddedSay(t)('remove')}
            disabled={busy || signIn.starting}
            onPress={remove}
          />
        </MobileBotCardActions>
      ) : null}
    </MobileBotCardFrame>
  )
}

const styles = themedStyleSheet(() => ({
  time: { color: colors.textMuted, marginLeft: 'auto' },
  error: { color: colors.statusRed },
  hint: { color: colors.textMuted },
  paste: { gap: spacing.xs },
  end: { marginLeft: 'auto' }
}))
