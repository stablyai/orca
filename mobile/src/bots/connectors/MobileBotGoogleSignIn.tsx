// Google's sign-in as a page inside the bot's settings, the trip Linear and GitHub use: Google's page opens
// in Orca's browser on the host, whose own loopback takes the return, and shows here in the sign-in sheet.
import { useEffect, useRef, type ReactNode } from 'react'
import { ArrowUpRight } from 'lucide-react-native'
import { BOT_CONNECTOR_NAMES } from '../../../../src/shared/bots/bot-templates'
import { ListRow } from '../../components/list/ListGroup'
import { SheetHeader } from '../../components/nav-bar/SheetHeader'
import type { Translate } from '../../i18n/mobile-i18n'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { useBackClaim } from '../../navigation/use-back-claim'
import { SettingsNote, SettingsSection } from '../../settings/settings-screen-frame'
import { MobileGoogleMark } from '../MobileConnectorSourceIcon'
import { connectorAccountErrorMessage } from './mobile-connector-account-copy'
import { HOST_OFFLINE } from './bot-slack-operations'
import type { ConnectorPage, GoogleSignInAsk } from './connector-pages'
import { ConnectorHandoff } from './MobileConnectorAccountParts'
import type { PhoneBot } from '../host-bots-operations'
import type { PhoneGoogle } from './phone-google-accounts'
import { GOOGLE_SIGN_IN_FAILED } from './connect-host-trip'
import { CONNECT_NOT_ROUTED, usePhoneConnectTrip, useSignInOnOpen } from './use-phone-connect-trip'
import { useMobileColors } from '../../theme/use-mobile-color-scheme'

function signInError(code: string, hostName: string, t: Translate): string {
  if (code === HOST_OFFLINE || code === CONNECT_NOT_ROUTED) {
    return connectorAccountErrorMessage('google', code, hostName, t)
  }
  // Otherwise the host's own sentence, as the desktop shows it.
  return code === GOOGLE_SIGN_IN_FAILED || code === 'expired'
    ? t('bots.google.signInRun.failed', 'The Google sign-in failed. Try again.')
    : code
}

export function MobileBotGoogleSignIn(props: {
  bot: PhoneBot
  google: PhoneGoogle
  ask: GoogleSignInAsk
  hostName: string
  online: boolean
  banner: ReactNode
  /** Google warns about an app that is the person's own and brand new. */
  newApp: boolean
  /** This page, reopened once the sign-in shown on the phone ends. */
  page: ConnectorPage
  onClose: () => void
  onSignedIn: () => void
}) {
  const colors = useMobileColors()
  const t = useMobileTranslation()
  const { hostName, ask } = props
  const { trip, start, cancel, showSignIn } = usePhoneConnectTrip('google', props.google.refresh)
  useSignInOnOpen(true, trip, () => start(ask))
  const waiting = trip.status === 'waiting'
  const close = () => {
    if (waiting) {
      cancel()
    }
    props.onClose()
  }
  useBackClaim(() => {
    close()
    return true
  })
  const linked = trip.status === 'linked'
  const done = useRef(false)
  useEffect(() => {
    if (linked && !done.current) {
      done.current = true
      props.onSignedIn()
    }
  })

  const error = trip.status === 'failed' ? signInError(trip.error, hostName, t) : null
  return (
    <>
      <SheetHeader
        title={t('bots.google.signIn', 'Sign in to Google')}
        subtitle={t('bots.setup.for', 'for {{name}}', { name: props.bot.name })}
        leading={
          waiting
            ? { label: t('bots.connect.cancel', 'Cancel'), onPress: close }
            : { label: t('bots.linear.setup.close', 'Close'), onPress: close }
        }
      />
      {props.banner}
      {waiting ? (
        <ConnectorHandoff
          hostName={hostName}
          message={t('bots.google.handoff', 'Pick your account and choose Allow.')}
          stuck={
            props.newApp
              ? t(
                  'bots.google.signInWarning',
                  'Google will show a warning because this app is yours and brand new. Choose Advanced, then Go to Orca, and tick every box on the next screen.'
                )
              : null
          }
          onOpenPage={showSignIn ? () => showSignIn(props.page) : null}
        />
      ) : linked ? null : (
        <>
          <SettingsSection
            first
            footer={
              error
                ? undefined
                : t('bots.connect.opensOnHost', 'Opens in Orca’s browser on {{host}}.', {
                    host: hostName
                  })
            }
          >
            <ListRow
              leading={<MobileGoogleMark size={20} />}
              title={BOT_CONNECTOR_NAMES.google}
              subtitle={ask.account}
            />
            <ListRow
              leading={<ArrowUpRight size={18} color={colors.accentBlue} />}
              accent
              title={
                error
                  ? t('bots.linear.setup.retry', 'Try again')
                  : t('bots.google.signIn', 'Sign in to Google')
              }
              accessibilityRole="link"
              disabled={!props.online}
              onPress={() => start(ask)}
            />
          </SettingsSection>
          {error ? <SettingsNote error>{error}</SettingsNote> : null}
        </>
      )}
    </>
  )
}
