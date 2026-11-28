import { useState } from 'react'
import { Text, View } from 'react-native'
import type {
  GoogleSetupAction,
  GoogleSetupBlocker
} from '../../../../../../src/shared/google/google-setup-blocker'
import { googleSetupActionAnswer } from '../../../../../../src/shared/google/google-setup-card-view'
import { intlLocaleFor } from '../../../../i18n/ui-intl-locale'
import { useMobileTranslation, useMobileUiLocale } from '../../../../i18n/use-mobile-translation'
import { useClipboardWriter } from '../../../../platform/clipboard/clipboard'
import type { RpcClient } from '../../../../transport/rpc/rpc-client-contract'
import { spacing, typography } from '../../../../theme/mobile-theme'
import { themedStyleSheet, useThemedStyles } from '../../../../theme/themed-styles'
import { scaledType } from '../messages/mobile-native-chat-message-styles'
import { MobileNativeChatNoticePill } from '../notices/MobileNativeChatNoticePill'
import { MobileBotCardActions } from './MobileBotCardFrame'
import { googleStatusRead } from './mobile-bot-card-operations'
import { answerMobileGoogleSetup } from './mobile-google-setup-store'
import {
  googleAdminRequest,
  googleSetupActionText,
  googleSetupBlockerText
} from './mobile-google-setup-blocker-copy'
import {
  MobileGoogleSetupError,
  MobileGoogleSetupMuted,
  MobileGoogleSetupOnComputer,
  useMobileGoogleSetupAnswer,
  type MobileGoogleSetupScope
} from './MobileGoogleSetupCardParts'

/** Where the setup is stuck and its buttons. One that signs in, imports a key or opens Google Cloud
 *  is on the computer, so the phone names it in one line instead. */
export function MobileGoogleSetupBlockerPanel({
  scope,
  blocker
}: {
  scope: MobileGoogleSetupScope
  blocker: GoogleSetupBlocker
}): React.JSX.Element {
  const styles = useThemedStyles(stylesSheet)
  const t = useMobileTranslation()
  const locale = intlLocaleFor(useMobileUiLocale())
  const clipboard = useClipboardWriter()
  const { busy, error, run } = useMobileGoogleSetupAnswer(scope)
  const [copied, setCopied] = useState(false)
  const { client, hostKey, botId, fontScale } = scope
  // What a button does from the phone: a card answer or the host's Google read; null when it's the
  // computer's (a sign-in, a key file, a Google Cloud page).
  const pressOf = (action: GoogleSetupAction): ((live: RpcClient) => Promise<void>) | null => {
    const answered = googleSetupActionAnswer(action, scope.run)
    if (answered) {
      return (live) => answerMobileGoogleSetup(live, hostKey, botId, answered.card, answered.values)
    }
    if (action.id === 'copy-for-admin') {
      return async (live) => {
        const status = googleStatusRead.interpret(await googleStatusRead.request(live, {}))
        if (status.client) {
          await clipboard.writeText(googleAdminRequest(t, status.client.clientId))
          setCopied(true)
        }
      }
    }
    if (action.id === 'check-again') {
      // Asks Google again; once it answers, the bot hears and runs done again.
      return async (live) => {
        googleStatusRead.interpret(await googleStatusRead.request(live, { check: true }))
        await answerMobileGoogleSetup(live, hostKey, botId, 'step', ['resume'])
      }
    }
    return null
  }
  const pressed = blocker.actions.map((action) => ({ action, press: pressOf(action) }))
  const shown = pressed.filter((entry) => entry.press !== null)
  const elsewhere = pressed.find((entry) => entry.press === null)?.action
  return (
    <View style={styles.panel}>
      <Text style={[styles.panelText, scaledType(typography.bodySize, fontScale)]}>
        {googleSetupBlockerText(t, locale, blocker)}
      </Text>
      <MobileGoogleSetupError text={error} fontScale={fontScale} />
      {copied ? (
        <MobileGoogleSetupMuted
          text={t('chat.botCards.google.copied', 'Copied. Send it to your Google admin.')}
          fontScale={fontScale}
        />
      ) : null}
      {shown.length > 0 ? (
        <MobileBotCardActions>
          {shown.map(({ action, press }, index) => (
            <MobileNativeChatNoticePill
              key={action.id}
              label={googleSetupActionText(t, locale, action)}
              primary={index === 0}
              disabled={busy}
              onPress={() => void run(async () => (client && press ? press(client) : undefined))}
            />
          ))}
        </MobileBotCardActions>
      ) : null}
      {elsewhere ? (
        <MobileGoogleSetupOnComputer
          text={t(
            'chat.botCards.google.action.onComputer',
            'For “{{action}}”, use Orca on your computer.',
            {
              action: googleSetupActionText(t, locale, elsewhere)
            }
          )}
          fontScale={fontScale}
        />
      ) : null}
    </View>
  )
}

const stylesSheet = themedStyleSheet((colors) => ({
  panel: { gap: spacing.sm },
  panelText: { color: colors.textPrimary }
}))
