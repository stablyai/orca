// One GitHub org's page in Connectors (or GitHub as a whole until it is linked and installed): the
// desktop's BotGitHubCard with GitHubAccountSettings' default bot. Adding repositories opens GitHub's
// install page in the phone's browser, and the host notices the change itself.
import { saveRemovingMembers } from '../bot-sheet-operations'
import { BOT_CONNECTOR_NAMES } from '../../../../src/shared/bots/bot-templates'
import { useState, type ReactNode } from 'react'
import {
  ArrowUpRight,
  BookMarked,
  Ellipsis,
  LogIn,
  Plus,
  RefreshCw,
  Unlink
} from '../../components/icons/app-icons'
import {
  botMemberSource,
  botMembersFrom,
  gitHubMembersOf,
  type BotMember
} from '../../../../src/shared/bot-types'
import {
  GITHUB_BOT_MENTION,
  gitHubLinkedAccounts,
  type ConnectorGitHubInstallation
} from '../../../../src/shared/connector-bot-github-contract'
import type { BotUpdateParams } from '../../../../src/shared/rpc-contract/bots-params'
import { ListRow, LIST_LEADING_INSET } from '../../components/list/ListGroup'
import { NavBarButton } from '../../components/nav-bar/NavBarButton'
import { NativeMenu } from '../../components/menu/NativeMenu'
import { SheetHeader } from '../../components/nav-bar/SheetHeader'
import { ConfirmContent } from '../../components/sheets/ConfirmModal'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { useBackClaim } from '../../navigation/use-back-claim'
import { openConnectorLink, GITHUB_LINK_HOSTS } from './connector-link'
import { SettingsNote, SettingsSection } from '../../settings/settings-screen-frame'
import { colors } from '../../theme/mobile-theme'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import type { PhoneBot } from '../host-bots-operations'
import type { BotAccessRequests } from '../use-bot-access-requests'
import { gitHubSetDefaultBot, gitHubUnlink } from './bot-connector-account-operations'
import { slackCall } from './bot-slack-operations'
import {
  ConnectorDefaultBotPage,
  useConnectorPeople,
  useFollowHost
} from './MobileConnectorAccountParts'
import { connectorAccountErrorMessage } from './mobile-connector-account-copy'
import type { PhoneGitHubView } from './use-phone-connector-account'

export function MobileBotGitHubPage(props: {
  client: RpcClient | null
  bot: PhoneBot
  accessBot: Parameters<typeof useConnectorPeople>[0]['accessBot']
  /** None: GitHub as a whole, until it is linked and installed. */
  installation: ConnectorGitHubInstallation | null
  github: { view: PhoneGitHubView; refresh: () => Promise<void> }
  hostBots: readonly PhoneBot[]
  access: BotAccessRequests | null
  hostName: string
  online: boolean
  banner: ReactNode
  showToast: (message: string, durationMs?: number) => void
  save: (updates: BotUpdateParams['updates']) => Promise<boolean>
  removeMember: (member: BotMember) => void
  onBack: () => void
  /** `signIn`: the setup opens on GitHub's sign-in with the account picker. */
  onSetUp: (signIn?: boolean) => void
}) {
  const t = useMobileTranslation()
  const { bot, installation, github, hostName } = props
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [pickingDefault, setPickingDefault] = useState(false)
  // The installs as they were when GitHub's page opened; followed until they change.
  const [following, setFollowing] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const state = github.view.status === 'ready' ? github.view.value : null
  const installs = state ? JSON.stringify(state.installations) : null
  const followOn = following !== null && installs === following
  useFollowHost(followOn, github.refresh)
  // The linked user who sees this org, as the desktop's gitHubLoginFor; else the first.
  const accounts = state ? gitHubLinkedAccounts(state) : []
  const account =
    accounts.find(
      (entry) => installation && entry.installations.includes(installation.installationId)
    ) ??
    accounts[0] ??
    null
  const people = useConnectorPeople({
    bot,
    accessBot: props.accessBot,
    people: installation
      ? gitHubMembersOf(bot.members, installation.installationId)
      : botMembersFrom(bot.members, 'github'),
    requests: [],
    access: props.access,
    online: props.online,
    removeMember: props.removeMember
  })
  useBackClaim(() => {
    if (!people.dismiss() && !confirmRemove && !pickingDefault) {
      props.onBack()
    }
    setConfirmRemove(false)
    setPickingDefault(false)
    return true
  })
  const place = installation?.accountLogin ?? BOT_CONNECTOR_NAMES.github
  const report = (result: { ok: true } | { ok: false; error: string }) => {
    if (!result.ok) {
      props.showToast(connectorAccountErrorMessage('github', result.error, hostName, t), 2400)
    }
    return github.refresh()
  }
  const addRepositories = () => {
    if (state && installs) {
      setFollowing(installs)
      openConnectorLink(state.installUrl, GITHUB_LINK_HOSTS)
    }
  }

  if (people.overlay) {
    return people.overlay
  }
  if (pickingDefault && account) {
    return (
      <ConnectorDefaultBotPage
        bots={props.hostBots.filter((other) => other.github !== null)}
        current={account.defaultBotId}
        online={props.online}
        banner={props.banner}
        onBack={() => setPickingDefault(false)}
        onPick={(botId) => {
          setPickingDefault(false)
          const client = props.client
          if (client) {
            void slackCall(
              () =>
                gitHubSetDefaultBot.request(
                  client,
                  { botId, userId: account.userId },
                  { failWhenDisconnected: true }
                ),
              gitHubSetDefaultBot.interpret
            ).then(report)
          }
        }}
      />
    )
  }
  if (confirmRemove) {
    return (
      <ConfirmContent
        title={t('bots.slack.connection.removeFromTitle', 'Remove {{name}} from {{place}}?', {
          name: bot.name,
          place
        })}
        message={t(
          'bots.github.connection.removeNote',
          'People can no longer ask it on GitHub, and its GitHub people are cleared. The Orca app stays installed.'
        )}
        confirmLabel={t('bots.github.connection.removeConfirm', 'Remove')}
        destructive
        onCancel={() => setConfirmRemove(false)}
        onConfirm={() => {
          setConfirmRemove(false)
          const removed = [
            ...(bot.github?.removedInstallationIds ?? []),
            ...(installation ? [installation.installationId] : [])
          ]
          const left = (state?.installations ?? []).filter(
            (entry) => !removed.includes(entry.installationId)
          )
          setBusy(true)
          // The last org takes GitHub off the bot, as the desktop does.
          const partial = installation && left.length > 0
          void saveRemovingMembers(
            props.save,
            bot.members.filter(
              (member) =>
                botMemberSource(member) === 'github' &&
                (!partial || member.workspaceId === installation.installationId)
            ),
            partial ? { github: { removedInstallationIds: removed } } : { github: null }
          ).then((saved) => {
            setBusy(false)
            if (saved) {
              props.onBack()
            }
          })
        }}
      />
    )
  }

  const ready = account !== null && (state?.installations.length ?? 0) > 0
  const defaultBot = account?.defaultBotId
    ? (props.hostBots.find((other) => other.id === account.defaultBotId)?.name ??
      t('bots.connect.otherComputer', 'A bot on another computer'))
    : t('bots.connect.askEachTime', 'Ask which bot')
  const repositories = installation
    ? installation.repositories === null
      ? [
          t('bots.github.allRepositories', 'All repositories of {{account}}', {
            account: installation.accountLogin
          })
        ]
      : installation.repositories.map((repository) => repository.fullName)
    : []
  /** `reconnect`: a wrong user is fixed by signing in again as the right one, as the desktop's Reconnect. */
  const unlink = (userId: string, reconnect: boolean) => {
    const client = props.client
    if (!client) {
      return
    }
    void slackCall(
      () => gitHubUnlink.request(client, { userId }, { failWhenDisconnected: true }),
      gitHubUnlink.interpret
    ).then((result) => {
      // The sign-in opens before the refresh, which may drop this org's page.
      if (result.ok && reconnect) {
        props.onSetUp(true)
      }
      return report(result)
    })
  }
  // A cloud that links several logins lists them, and signs in again to add or refresh them.
  const signsIn = ready && state?.accounts !== undefined
  const menu = [
    // The org's page has its own Add row.
    ...(state && ready && !installation
      ? [
          {
            label: t('bots.connectors.addGitHubAccess', 'Add repositories or organizations'),
            icon: Plus,
            disabled: !props.online,
            onPress: addRepositories
          }
        ]
      : []),
    ...(signsIn
      ? [
          {
            label: t('bots.github.connection.addAnotherAccount', 'Add another account'),
            icon: Plus,
            disabled: !props.online,
            onPress: () => props.onSetUp(true)
          },
          {
            label: t('bots.github.connection.refresh', 'Refresh'),
            icon: RefreshCw,
            disabled: !props.online,
            onPress: () => props.onSetUp(true)
          }
        ]
      : [])
  ]
  const accountMenu = account
    ? [
        {
          label: t('bots.github.account.reconnect', 'Reconnect'),
          icon: LogIn,
          disabled: !props.online,
          onPress: () => unlink(account.userId, true)
        },
        {
          label: t('bots.github.account.unlink', 'Unlink GitHub account'),
          icon: Unlink,
          disabled: !props.online,
          onPress: () => unlink(account.userId, false)
        }
      ]
    : []
  return (
    <>
      <SheetHeader
        title={BOT_CONNECTOR_NAMES.github}
        subtitle={installation?.accountLogin}
        onBack={{ label: t('bots.connectors.back', 'Back to Connectors'), onPress: props.onBack }}
        trailingButtons={
          menu.length + accountMenu.length > 0 ? (
            <NativeMenu groups={[menu, accountMenu].filter((group) => group.length > 0)}>
              {(openMenu) => (
                <NavBarButton
                  icon={Ellipsis}
                  accessibilityLabel={t('bots.connector.actions', '{{name}} actions', {
                    name: BOT_CONNECTOR_NAMES.github
                  })}
                  onPress={openMenu}
                />
              )}
            </NativeMenu>
          ) : undefined
        }
      />
      {props.banner}
      <SettingsNote>
        {t(
          'bots.github.howToAskPlain',
          'Mention {{mention}} {{handle}} … on an issue or pull request.',
          { mention: GITHUB_BOT_MENTION, handle: bot.folder }
        )}
      </SettingsNote>
      {github.view.status === 'failed' ? (
        <SettingsNote error>
          {connectorAccountErrorMessage('github', github.view.error, hostName, t)}
        </SettingsNote>
      ) : null}
      {state && !ready ? (
        <SettingsSection>
          <ListRow
            title={t('bots.github.connection.finishSetup', 'Finish setup')}
            value={
              account
                ? t('settings.bots.githubStatus.notInstalled', 'Orca not installed')
                : t('settings.bots.githubStatus.unlinked', 'Not linked')
            }
            navigates
            disabled={!props.online}
            onPress={props.onSetUp}
          />
        </SettingsSection>
      ) : null}
      {account ? (
        <SettingsSection title={t('bots.connect.account', 'Account')}>
          <ListRow title={t('bots.connect.linkedAs', 'Linked as')} value={`@${account.login}`} />
          <ListRow
            title={t('bots.connect.defaultBot', 'Default bot for my requests')}
            value={defaultBot}
            navigates
            disabled={!props.online}
            onPress={() => setPickingDefault(true)}
          />
        </SettingsSection>
      ) : null}
      {installation ? (
        <SettingsSection
          title={t('bots.github.setup.repositories', 'Repositories')}
          separatorInset={LIST_LEADING_INSET}
        >
          {repositories.map((name) => (
            <ListRow
              key={name}
              leading={<BookMarked size={18} color={colors.textSecondary} />}
              title={name}
            />
          ))}
          <ListRow
            leading={<ArrowUpRight size={18} color={colors.accentBlue} />}
            accent
            title={t('bots.github.addMore', 'Add repositories or an organization')}
            accessibilityRole="link"
            disabled={!props.online}
            onPress={addRepositories}
          />
        </SettingsSection>
      ) : null}
      {followOn ? (
        <SettingsNote>
          {t('bots.github.checkingInstalls', 'Checking GitHub for changes…')}
        </SettingsNote>
      ) : null}
      {people.section}
      {bot.github ? (
        <SettingsSection>
          <ListRow
            title={t('bots.connector.removeFrom', 'Remove from {{place}}…', { place })}
            destructive
            disabled={!props.online || busy}
            accessibilityRole="button"
            onPress={() => setConfirmRemove(true)}
          />
        </SettingsSection>
      ) : null}
    </>
  )
}
