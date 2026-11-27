// A tool this chat's bot gave itself, as a status row: whether it is still there, its sign-in, and Remove.
// Signing in opens the app's page in the phone's browser and finishes from the address it lands on, pasted here.
import { useCallback, useEffect, useState } from 'react'
import { Pressable, Text, View } from 'react-native'
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
import { feedback, pressedStyle, spacing, typography } from '../../../../theme/mobile-theme'
import { themedStyleSheet, useThemedStyles } from '../../../../theme/themed-styles'
import {
  MobileNativeChatEventName,
  MobileNativeChatEventRow
} from '../messages/MobileNativeChatEventRow'
import { scaledType } from '../messages/mobile-native-chat-message-styles'
import { MobileNativeChatNoticePill } from '../notices/MobileNativeChatNoticePill'
import { mobileBotToolAddedSay } from './mobile-bot-card-copy'
import { useMobileBotCardHost } from './mobile-bot-card-host'
import { MobileBotCardActions } from './MobileBotCardFrame'
import { composerInputStylesSheet } from '../../../../components/composer-input/composer-input-styles'
import { useMobileColors } from '../../../../theme/use-mobile-color-scheme'

export function MobileBotToolAddedCard({
  added,
  timestamp,
  fontScale
}: {
  added: NativeChatBotCardValues['toolAdded']
  timestamp: number | null
  fontScale: number
}): React.JSX.Element {
  const styles = useThemedStyles(stylesSheet)
  const composerInputStyles = useThemedStyles(composerInputStylesSheet)
  const colors = useMobileColors()
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
  const say = mobileBotToolAddedSay(t)
  const view = botToolAddedCardView(
    own === null ? null : live !== undefined,
    botToolSubtitle(live ?? tool),
    botToolSignInLine(face, t, hostName),
    say
  )
  const title = botToolTitle(tool.name)
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
  const meta = scaledType(typography.metaSize, fontScale, 4)
  return (
    <View testID={`bot-tool-added-card:${tool.name}`}>
      <MobileNativeChatEventRow
        icon={<Wrench size={14} color={colors.textMuted} strokeWidth={2} />}
        label={[`${view.lead} ${title}`, ...view.after].join(' · ')}
        timestamp={timestamp}
        fontScale={fontScale}
        action={
          view.present && !attempt ? (
            <View style={styles.actions}>
              {action ? (
                <RowAction
                  label={action}
                  disabled={busy || signIn.starting}
                  onPress={signIn.start}
                  fontScale={fontScale}
                />
              ) : null}
              <RowAction
                label={say('remove')}
                disabled={busy || signIn.starting}
                onPress={remove}
                fontScale={fontScale}
              />
            </View>
          ) : null
        }
      >
        {view.lead} <MobileNativeChatEventName>{title}</MobileNativeChatEventName>
        {view.after.map((part) => ` · ${part}`).join('')}
      </MobileNativeChatEventRow>
      {view.present && attempt ? (
        <View style={styles.paste}>
          <Text style={[styles.hint, meta]}>
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
            style={composerInputStyles.filledField}
          />
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
        </View>
      ) : null}
      {shownError ? <Text style={[styles.error, styles.indent, meta]}>{shownError}</Text> : null}
    </View>
  )
}

/** A word button after the row's words, as the desktop row's sign-in and Remove. */
function RowAction({
  label,
  disabled,
  onPress,
  fontScale
}: {
  label: string
  disabled: boolean
  onPress: () => void
  fontScale: number
}): React.JSX.Element {
  const styles = useThemedStyles(stylesSheet)
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      hitSlop={8}
      onPress={onPress}
      style={({ pressed }) => [disabled && styles.disabled, pressed && pressedStyle]}
    >
      <Text style={[styles.action, scaledType(typography.metaSize, fontScale, 4)]}>{label}</Text>
    </Pressable>
  )
}

const stylesSheet = themedStyleSheet((colors) => ({
  actions: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  action: { color: colors.textPrimary, fontWeight: '500' },
  disabled: { opacity: feedback.disabledOpacity },
  error: { color: colors.statusRed },
  hint: { color: colors.textMuted },
  // Under the row's words, past its 14pt mark and gap.
  indent: { marginLeft: 20 },
  paste: { gap: spacing.xs, marginLeft: 20, marginTop: spacing.xs },
  end: { marginLeft: 'auto' }
}))
