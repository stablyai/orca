// Signing a tool in from the phone, set up before Orca opens the browser, so the page that won't
// load at the end isn't a surprise; the address it lands on is pasted back here.
import { useState, type ReactNode } from 'react'
import { Text, View } from 'react-native'
import { ArrowUpRight, Check } from 'lucide-react-native'
import { ListRow } from '../../components/list/ListGroup'
import { TextField } from '../../components/composer-input/TextField'
import { SheetHeader } from '../../components/nav-bar/SheetHeader'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { SettingsNote, SettingsSection } from '../../settings/settings-screen-frame'
import { spacing } from '../../theme/mobile-theme'
import { themedStyleSheet, useThemedStyles } from '../../theme/themed-styles'
import { useMobileColors } from '../../theme/use-mobile-color-scheme'
import type { BotToolPhoneSignIn } from './use-bot-tool-phone-sign-in'

/** A step's number, or a tick once it's done. */
export function StepNumber({ n, done = false }: { n: number; done?: boolean }) {
  const colors = useMobileColors()
  const styles = useThemedStyles(stylesSheet)
  return (
    <View style={[styles.number, done && styles.numberDone]}>
      {done ? (
        <Check size={14} color={colors.bgBase} strokeWidth={3} />
      ) : (
        <Text style={styles.numberText}>{n}</Text>
      )}
    </View>
  )
}

export function MobileBotToolSignInPage(props: {
  app: string
  hostName: string
  signIn: BotToolPhoneSignIn
  disabled: boolean
  banner: ReactNode
  onClose: () => void
}) {
  const t = useMobileTranslation()
  const colors = useMobileColors()
  const styles = useThemedStyles(stylesSheet)
  const { signIn } = props
  const [address, setAddress] = useState('')
  const attempt = signIn.attempt
  const pasted = address.trim()
  const finish = () => {
    if (pasted && attempt && !attempt.finishing) {
      signIn.finish(pasted)
    }
  }
  const steps = [
    {
      title: t('bots.tools.signIn.action', 'Sign in'),
      detail: t('bots.tools.signIn.step1Detail', 'Sign in to {{app}} and allow access.', {
        app: props.app
      })
    },
    {
      title: t('bots.tools.signIn.step2', 'Copy the address'),
      detail: t(
        'bots.tools.signIn.step2Detail',
        'The last page won’t load. That’s expected. Copy its address.'
      )
    },
    {
      title: t('bots.tools.signIn.step3', 'Paste it here'),
      detail: t('bots.tools.signIn.step3Detail', 'Orca finishes the sign-in on {{host}}.', {
        host: props.hostName
      })
    }
  ]
  return (
    <>
      <SheetHeader
        title={t('bots.tools.signIn.title', 'Sign in to {{app}}', { app: props.app })}
        leading={{ label: t('common.cancel', 'Cancel'), onPress: props.onClose }}
        trailing={{
          label: t('bots.tools.signIn.finish', 'Finish'),
          onPress: finish,
          disabled: props.disabled || !attempt || !pasted,
          busy: attempt?.finishing
        }}
      />
      {props.banner}
      <SettingsSection first>
        {steps.map((step, index) => (
          <ListRow
            key={step.title}
            title={step.title}
            subtitle={step.detail}
            subtitleLines={3}
            // Pasting the address shows the first two done, as the page's browser steps are.
            leading={
              <StepNumber n={index + 1} done={index < 2 && attempt !== null && pasted !== ''} />
            }
          />
        ))}
      </SettingsSection>
      {signIn.failure === 'needs-update' ? (
        <SettingsNote>
          {t('bots.tools.updateHost', 'Update Orca on {{host}} to sign in to apps', {
            host: props.hostName
          })}
        </SettingsNote>
      ) : attempt?.url || !attempt ? (
        <SettingsSection>
          <ListRow
            leading={<ArrowUpRight size={18} color={colors.accentBlue} />}
            accent
            title={
              attempt
                ? t('bots.tools.signIn.openAgain', 'Open page again')
                : t('bots.tools.signIn.open', 'Open sign-in page')
            }
            accessibilityRole="link"
            busy={signIn.starting}
            // Opening the page again needs only the phone's browser.
            disabled={!attempt && props.disabled}
            onPress={attempt ? signIn.openAgain : signIn.start}
          />
        </SettingsSection>
      ) : null}
      {attempt ? (
        <TextField
          style={styles.paste}
          value={address}
          onChangeText={setAddress}
          placeholder={t('bots.tools.signIn.pastePlaceholder', 'Paste the address')}
          accessibilityLabel={t('bots.tools.address', 'Address')}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          returnKeyType="done"
          editable={!attempt.finishing}
          onSubmitEditing={finish}
        />
      ) : null}
      {signIn.error ? <SettingsNote error>{signIn.error}</SettingsNote> : null}
    </>
  )
}

const stylesSheet = themedStyleSheet((colors) => ({
  number: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: colors.translucentFill,
    alignItems: 'center',
    justifyContent: 'center'
  },
  numberDone: { backgroundColor: colors.textPrimary },
  numberText: { fontSize: 13, fontWeight: '600', color: colors.textPrimary },
  paste: { marginTop: spacing.lg }
}))
