// Connect GitHub as a page inside the bot's settings: the desktop's BotGitHubSetupDialog. The account link
// returns to 127.0.0.1 on the host, so it opens in Orca's browser there (shown here as that tab) and the
// phone waits; GitHub's install page works in any browser, so it opens in the phone's, and the host
// notices the install.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ActivityIndicator } from 'react-native'
import { ArrowUpRight } from 'lucide-react-native'
import {
  BOT_GITHUB_OFF,
  GITHUB_BOT_MENTION,
  type ConnectorGitHubInstallation
} from '../../../../src/shared/connector-bot-github-contract'
import { BOT_CONNECTOR_NAMES } from '../../../../src/shared/bots/bot-templates'
import { joinSentences } from '../../../../src/shared/text/sentence-joining'
import { MobileStateView } from '../../components/feedback/MobileStateView'
import { ListRow } from '../../components/list/ListGroup'
import { SheetHeader } from '../../components/nav-bar/SheetHeader'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { useBackClaim } from '../../navigation/use-back-claim'
import { openConnectorLink, GITHUB_LINK_HOSTS } from './connector-link'
import { SettingsNote, SettingsSection } from '../../settings/settings-screen-frame'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import type { PhoneBot } from '../host-bots-operations'
import { MobileConnectorLogo } from '../MobileConnectorSourceIcon'
import { ConnectorHandoff, useFollowHost } from './MobileConnectorAccountParts'
import { connectorAccountErrorMessage } from './mobile-connector-account-copy'
import { MobileConnectorTryIt } from './MobileConnectorTryIt'
import type { ConnectorPage } from './connector-pages'
import type { PhoneGitHubView } from './use-phone-connector-account'
import { usePhoneConnectTrip, useSignInOnOpen } from './use-phone-connect-trip'
import { useMobileColors } from '../../theme/use-mobile-color-scheme'

/** The repositories as one line, as the desktop's gitHubInstallationLabel. */
function gitHubRepositoriesLine(
  installation: ConnectorGitHubInstallation,
  allOf: (account: string) => string
): string {
  return installation.repositories === null
    ? allOf(installation.accountLogin)
    : installation.repositories.map((repository) => repository.fullName).join(', ')
}

export function MobileBotGitHubSetup(props: {
  client: RpcClient | null
  bot: PhoneBot
  github: { view: PhoneGitHubView; refresh: () => Promise<void> }
  /** Opens on GitHub's sign-in with the account picker. */
  signIn: boolean
  hostName: string
  online: boolean
  banner: ReactNode
  showToast: (message: string) => void
  save: (updates: { github: Record<string, never> }) => Promise<boolean>
  /** This page, reopened once a sign-in shown on the phone ends. */
  page: ConnectorPage
  onClose: () => void
  /** On GitHub, after Try it: its page takes over. */
  onDone: () => void
}) {
  const colors = useMobileColors()
  const t = useMobileTranslation()
  const { bot, github, hostName } = props
  const [saving, setSaving] = useState(false)
  const [opened, setOpened] = useState(false)
  const [done, setDone] = useState(false)
  const { trip, start, cancel, showSignIn } = usePhoneConnectTrip('github', github.refresh)
  useSignInOnOpen(props.signIn, trip, start)
  useBackClaim(() => {
    if (done) {
      props.onDone()
    } else {
      props.onClose()
    }
    return true
  })
  const state = github.view.status === 'ready' ? github.view.value : null
  const step =
    trip.status === 'waiting'
      ? 'waiting'
      : github.view.status === 'loading'
        ? 'checking'
        : !state
          ? 'failed'
          : // A sign-in this page opened for that failed shows its error, not the account it replaced.
            !state.account || (props.signIn && trip.status === 'failed')
            ? 'connect'
            : state.installations.length === 0
              ? 'install'
              : 'turn-on'
  useFollowHost(step === 'install', github.refresh)

  const turnOn = async () => {
    setSaving(true)
    const saved = bot.github !== null || (await props.save({ github: {} }))
    setSaving(false)
    if (saved) {
      setDone(true)
    }
  }
  // The sign-in was for turning the bot on: once it links with Orca installed, it turns on.
  const resumed = useRef(false)
  useEffect(() => {
    if (trip.status === 'linked' && step === 'turn-on' && !resumed.current) {
      resumed.current = true
      // Add account, Refresh and Reconnect only link again, as the desktop's; the bot stays as it is.
      if (props.signIn) {
        props.onClose()
      } else {
        void turnOn()
      }
    }
  })

  if (done) {
    const command = `${GITHUB_BOT_MENTION} ${bot.folder}`
    return (
      <MobileConnectorTryIt
        connector="github"
        subtitle={t('bots.github.setup.isOn', '{{name}} is on GitHub', { name: bot.name })}
        heading={t('bots.github.setup.tryIt', 'Try it on any issue or PR')}
        prompt={{
          text: `${command} ${t('bots.github.setup.preview.ask', 'review this PR')}`,
          copy: command
        }}
        footer={t(
          'bots.github.setup.pushesOnHost',
          '{{name}} pushes code from {{host}} with its git login.',
          { name: bot.name, host: hostName }
        )}
        banner={props.banner}
        showToast={props.showToast}
        onDone={props.onDone}
      />
    )
  }
  const mark = <MobileConnectorLogo source="github" size={28} />
  const error = (code: string) => connectorAccountErrorMessage('github', code, hostName, t)
  const openInstall = () => {
    if (state) {
      setOpened(true)
      openConnectorLink(state.installUrl, GITHUB_LINK_HOSTS)
    }
  }
  const body = (() => {
    switch (step) {
      case 'checking':
        return (
          <MobileStateView loading title={t('bots.github.setup.checking', 'Checking GitHub…')} />
        )
      case 'failed': {
        const code = github.view.status === 'failed' ? github.view.error : ''
        return (
          <MobileStateView
            iconElement={mark}
            title={error(code)}
            action={
              code === BOT_GITHUB_OFF || !props.online
                ? null
                : {
                    label: t('bots.github.setup.retry', 'Try again'),
                    onPress: () => void github.refresh()
                  }
            }
          />
        )
      }
      case 'connect': {
        const failed = trip.status === 'failed' ? trip.error : null
        return (
          <>
            <SettingsSection
              first
              footer={
                failed
                  ? undefined
                  : joinSentences([
                      t('bots.connect.opensOnHost', 'Opens in Orca’s browser on {{host}}.', {
                        host: hostName
                      }),
                      t(
                        'bots.github.connect.readsOnly',
                        'Orca only reads your GitHub username and id.'
                      )
                    ])
              }
            >
              <ListRow
                leading={<MobileConnectorLogo source="github" size={20} />}
                title={BOT_CONNECTOR_NAMES.github}
                subtitle={t(
                  'bots.github.connect.pickSubtitle',
                  'Choose the repositories it can work in'
                )}
              />
              <ListRow
                leading={<ArrowUpRight size={18} color={colors.accentBlue} />}
                accent
                title={
                  failed
                    ? t('bots.github.setup.retry', 'Try again')
                    : t('bots.github.connect.signIn', 'Sign in to GitHub')
                }
                accessibilityRole="link"
                disabled={!props.online}
                onPress={() => start(props.signIn)}
              />
            </SettingsSection>
            {failed ? <SettingsNote error>{error(failed)}</SettingsNote> : null}
          </>
        )
      }
      case 'waiting':
        return (
          <ConnectorHandoff
            hostName={hostName}
            message={t('bots.github.connect.handoffPick', 'Sign in and choose the repositories.')}
            onOpenPage={showSignIn ? () => showSignIn(props.page) : null}
          />
        )
      case 'install':
        return (
          <SettingsSection
            first
            footer={
              opened
                ? t(
                    'bots.github.setup.installing',
                    'Waiting for the install, or for an owner of the organization to approve…'
                  )
                : undefined
            }
          >
            <ListRow
              leading={<ArrowUpRight size={18} color={colors.accentBlue} />}
              accent
              title={t('bots.github.setup.install', 'Install the Orca app')}
              subtitle={
                trip.status === 'linked' && trip.link?.install === 'requested'
                  ? t(
                      'bots.github.connect.requested',
                      'An owner of the organization has been asked to approve the Orca app.'
                    )
                  : t(
                      'bots.github.connect.notInstalled',
                      'The Orca app is not on any of your repositories yet.'
                    )
              }
              accessory={
                opened ? <ActivityIndicator size="small" color={colors.textSecondary} /> : undefined
              }
              accessibilityRole="link"
              disabled={!props.online}
              onPress={openInstall}
            />
          </SettingsSection>
        )
      case 'turn-on':
        return (
          <SettingsSection
            first
            title={t('bots.github.setup.repositories', 'Repositories')}
            footer={t('bots.connect.signedInAs', 'Signed in as {{who}}', {
              who: `@${state?.account?.login ?? ''}`
            })}
          >
            {(state?.installations ?? []).map((installation) => (
              <ListRow
                key={installation.installationId}
                leading={<MobileConnectorLogo source="github" size={20} />}
                title={installation.accountLogin}
                subtitle={gitHubRepositoriesLine(installation, (account) =>
                  t('bots.github.allRepositories', 'All repositories of {{account}}', {
                    account
                  })
                )}
              />
            ))}
          </SettingsSection>
        )
    }
  })()
  return (
    <>
      <SheetHeader
        title={t('bots.github.setup.connectTitle', 'Connect GitHub')}
        subtitle={t('bots.setup.for', 'for {{name}}', { name: bot.name })}
        leading={
          step === 'waiting'
            ? { label: t('bots.connect.cancel', 'Cancel'), onPress: cancel }
            : { label: t('bots.github.setup.close', 'Close'), onPress: props.onClose }
        }
        trailing={
          step === 'turn-on'
            ? {
                label: bot.github
                  ? t('bots.github.setup.finish', 'Done')
                  : t('bots.connect.turnOnShort', 'Turn on'),
                busy: saving,
                disabled: !props.online,
                onPress: () => void turnOn()
              }
            : undefined
        }
      />
      {props.banner}
      {body}
    </>
  )
}
