// Connect GitHub as a page inside the bot's settings: the desktop's BotGitHubSetupDialog. The account link
// returns to 127.0.0.1 on the host, so it opens in Orca's browser there and the phone waits; GitHub's
// install page works in any browser, so it opens in the phone's, and the host notices the install.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { View } from 'react-native'
import { ArrowUpRight, ExternalLink } from '../../components/icons/app-icons'
import {
  BOT_GITHUB_OFF,
  type ConnectorGitHubInstallation
} from '../../../../src/shared/connector-bot-github-contract'
import { MobileStateView } from '../../components/feedback/MobileStateView'
import { ListRow } from '../../components/list/ListGroup'
import { SheetHeader } from '../../components/nav-bar/SheetHeader'
import { SheetPrimaryButton } from '../../components/sheets/SheetPrimaryButton'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { useBackClaim } from '../../navigation/use-back-claim'
import { openConnectorLink, GITHUB_LINK_HOSTS } from './connector-link'
import { SettingsNote, SettingsSection } from '../../settings/settings-screen-frame'
import { spacing } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import type { PhoneBot } from '../host-bots-operations'
import { MobileConnectorSourceIcon } from '../MobileConnectorSourceIcon'
import { ConnectorHandoff, useFollowHost } from './MobileConnectorAccountParts'
import { connectorAccountErrorMessage } from './mobile-connector-account-copy'
import type { PhoneGitHubView } from './use-phone-connector-account'
import { usePhoneConnectTrip } from './use-phone-connect-trip'

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
  hostName: string
  online: boolean
  banner: ReactNode
  save: (updates: { github: Record<string, never> }) => Promise<boolean>
  onClose: () => void
  /** On GitHub: its page takes over. */
  onDone: () => void
}) {
  const t = useMobileTranslation()
  const { bot, github, hostName } = props
  const [saving, setSaving] = useState(false)
  const [opened, setOpened] = useState(false)
  const { trip, start, cancel } = usePhoneConnectTrip(
    props.client,
    'github',
    bot.folderWorkspaceId,
    github.refresh
  )
  useBackClaim(() => {
    props.onClose()
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
          : !state.account
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
      props.onDone()
    }
  }
  // The sign-in was for turning the bot on: once it links with Orca installed, it turns on.
  const resumed = useRef(false)
  useEffect(() => {
    if (trip.status === 'linked' && step === 'turn-on' && !resumed.current) {
      resumed.current = true
      void turnOn()
    }
  })

  const mark = <MobileConnectorSourceIcon source="github" size={28} />
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
      case 'connect':
        return (
          <MobileStateView
            iconElement={mark}
            title={t(
              'bots.github.connect.pickRepositories',
              'Sign in and choose which repositories {{name}} can work in.',
              { name: bot.name }
            )}
            message={
              trip.status === 'failed'
                ? error(trip.error)
                : t('bots.github.connect.readsOnly', 'Orca only reads your GitHub username and id.')
            }
          >
            <SheetPrimaryButton
              label={t('bots.github.connect.button', 'Connect GitHub')}
              icon={ArrowUpRight}
              disabled={!props.online}
              onPress={() => start()}
            />
            <SettingsNote>
              {t('bots.connect.opensOnHost', 'Opens in Orca’s browser on {{host}}.', {
                host: hostName
              })}
            </SettingsNote>
          </MobileStateView>
        )
      case 'waiting':
        return (
          <ConnectorHandoff
            hostName={hostName}
            message={t(
              'bots.github.connect.handoff',
              'GitHub’s sign-in is open in Orca’s browser there. Sign in and choose the repositories; this updates when you finish.'
            )}
            waiting={t(
              'bots.github.connect.waitingOn',
              'Finish signing in to GitHub on {{host}}…',
              {
                host: hostName
              }
            )}
            onCancel={cancel}
          />
        )
      case 'install':
        return (
          <MobileStateView
            iconElement={mark}
            title={
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
            message={
              opened
                ? t(
                    'bots.github.setup.installing',
                    'Waiting for the install, or for an owner of the organization to approve…'
                  )
                : undefined
            }
          >
            <SheetPrimaryButton
              label={t('bots.github.setup.install', 'Install the Orca app')}
              icon={ExternalLink}
              disabled={!props.online}
              onPress={openInstall}
            />
          </MobileStateView>
        )
      case 'turn-on':
        return (
          <>
            <SettingsNote>
              {t('bots.connect.signedInAs', 'Signed in as {{who}}', {
                who: `@${state?.account?.login ?? ''}`
              })}
            </SettingsNote>
            <SettingsSection title={t('bots.github.setup.repositories', 'Repositories')}>
              {(state?.installations ?? []).map((installation) => (
                <ListRow
                  key={installation.installationId}
                  title={installation.accountLogin}
                  subtitle={gitHubRepositoriesLine(installation, (account) =>
                    t('bots.github.allRepositories', 'All repositories of {{account}}', {
                      account
                    })
                  )}
                />
              ))}
            </SettingsSection>
            <View style={styles.action}>
              <SheetPrimaryButton
                label={
                  bot.github
                    ? t('bots.github.setup.finish', 'Done')
                    : t('bots.github.connect.turnOn', 'Turn on {{name}}', { name: bot.name })
                }
                busy={saving}
                disabled={!props.online}
                onPress={() => void turnOn()}
              />
            </View>
          </>
        )
    }
  })()
  return (
    <>
      <SheetHeader
        title={t('bots.github.setup.connectTitle', 'Connect GitHub')}
        subtitle={t('bots.setup.for', 'for {{name}}', { name: bot.name })}
        leading={{ label: t('bots.github.setup.close', 'Close'), onPress: props.onClose }}
      />
      {props.banner}
      {body}
    </>
  )
}

const styles = themedStyleSheet(() => ({
  action: { marginTop: spacing.lg }
}))
