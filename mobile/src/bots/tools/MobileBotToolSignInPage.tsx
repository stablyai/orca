// Signing a tool in from the phone, set up before Orca opens the browser, so the page that won't
// load at the end isn't a surprise; the address it lands on is pasted back here.
import { useState, type ReactNode } from 'react'
import { Text, View } from 'react-native'
import { ExternalLink } from 'lucide-react-native'
import { ListRow } from '../../components/list/ListGroup'
import { TextField } from '../../components/composer-input/TextField'
import { SheetHeader } from '../../components/nav-bar/SheetHeader'
import { SheetPrimaryButton } from '../../components/sheets/SheetPrimaryButton'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { SettingsNote, SettingsSection } from '../../settings/settings-screen-frame'
import { colors, spacing } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { MobileBotTextButton } from '../MobileBotTextButton'
import type { BotToolPhoneSignIn } from './use-bot-tool-phone-sign-in'

function StepNumber({ n }: { n: number }) {
  return (
    <View style={styles.number}>
      <Text style={styles.numberText}>{n}</Text>
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
  useMobileColorScheme()
  const { signIn } = props
  const [address, setAddress] = useState('')
  const attempt = signIn.attempt
  const pasted = address.trim()
  const finish = () => {
    if (pasted) {
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
        onBack={{ label: t('common.back', 'Back'), onPress: props.onClose }}
      />
      {props.banner}
      <SettingsSection first>
        {steps.map((step, index) => (
          <ListRow
            key={step.title}
            title={step.title}
            subtitle={step.detail}
            subtitleLines={3}
            leading={<StepNumber n={index + 1} />}
          />
        ))}
      </SettingsSection>
      {attempt ? (
        <View style={styles.paste}>
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
          {attempt.url ? (
            <View style={styles.openAgain}>
              <ExternalLink size={13} color={colors.textSecondary} />
              <MobileBotTextButton
                label={t('bots.tools.signIn.openAgain', 'Open page again')}
                onPress={signIn.openAgain}
              />
            </View>
          ) : null}
        </View>
      ) : null}
      {signIn.error ? <SettingsNote error>{signIn.error}</SettingsNote> : null}
      {signIn.failure === 'needs-update' ? (
        <SettingsNote>
          {t('bots.tools.updateHost', 'Update Orca on {{host}} to sign in to apps', {
            host: props.hostName
          })}
        </SettingsNote>
      ) : (
        <View style={styles.primary}>
          {attempt ? (
            <SheetPrimaryButton
              label={t('bots.tools.signIn.finish', 'Finish')}
              busy={attempt.finishing}
              disabled={props.disabled || !pasted}
              onPress={finish}
            />
          ) : (
            <SheetPrimaryButton
              label={t('bots.tools.signIn.open', 'Open sign-in page')}
              icon={ExternalLink}
              busy={signIn.starting}
              disabled={props.disabled}
              onPress={signIn.start}
            />
          )}
        </View>
      )}
    </>
  )
}

const styles = themedStyleSheet(() => ({
  number: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: colors.translucentFill,
    alignItems: 'center',
    justifyContent: 'center'
  },
  numberText: { fontSize: 13, fontWeight: '600', color: colors.textPrimary },
  paste: { paddingTop: spacing.lg, gap: spacing.xs },
  openAgain: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-end',
    gap: 2
  },
  primary: { paddingTop: spacing.lg }
}))
