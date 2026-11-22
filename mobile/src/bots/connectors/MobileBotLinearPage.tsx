// One Linear workspace's page in Connectors: the desktop's BotLinearCard with the workspace's part of
// LinearAccountSettings. How to ask, who the host is linked as and its default bot, Who can ask, Remove.
import { saveRemovingMembers } from '../bot-sheet-operations'
import { BOT_CONNECTOR_NAMES } from '../../../../src/shared/bots/bot-templates'
import { useRef, useState, type ReactNode } from 'react'
import { Ellipsis, Plus } from 'lucide-react-native'
import {
  botLinearWorkspaces,
  botMemberSource,
  linearMembersOf,
  type BotLinearLink,
  type BotMember
} from '../../../../src/shared/bot-types'
import type { BotUpdateParams } from '../../../../src/shared/rpc-contract/bots-params'
import { ListRow } from '../../components/list/ListGroup'
import { NavBarButton } from '../../components/nav-bar/NavBarButton'
import { PullDownMenu } from '../../components/nav-bar/PullDownMenu'
import { SheetHeader } from '../../components/nav-bar/SheetHeader'
import { ConfirmContent } from '../../components/sheets/ConfirmModal'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { useBackClaim } from '../../navigation/use-back-claim'
import { SettingsNote, SettingsSection } from '../../settings/settings-screen-frame'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import type { PhoneBot } from '../host-bots-operations'
import type { BotAccessRequests } from '../use-bot-access-requests'
import { linearSetDefaultBot } from './bot-connector-account-operations'
import { slackCall } from './bot-slack-operations'
import { ConnectorDefaultBotPage, useConnectorPeople } from './MobileConnectorAccountParts'
import { connectorAccountErrorMessage, linearWorkspaceLabel } from './mobile-connector-account-copy'
import type { PhoneLinearView } from './use-phone-connector-account'

export function MobileBotLinearPage(props: {
  client: RpcClient | null
  bot: PhoneBot
  accessBot: Parameters<typeof useConnectorPeople>[0]['accessBot']
  workspace: BotLinearLink
  linear: { view: PhoneLinearView; refresh: () => Promise<void> }
  hostBots: readonly PhoneBot[]
  access: BotAccessRequests | null
  hostName: string
  online: boolean
  banner: ReactNode
  showToast: (message: string, durationMs?: number) => void
  save: (updates: BotUpdateParams['updates']) => Promise<boolean>
  removeMember: (member: BotMember) => void
  onBack: () => void
  /** Finish setup in this workspace, or with none, add another. */
  onSetUp: (workspaceId: string | undefined) => void
}) {
  const t = useMobileTranslation()
  const { bot, workspace, linear, hostName } = props
  const [menuOpen, setMenuOpen] = useState(false)
  const menuAnchor = useRef(null)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [pickingDefault, setPickingDefault] = useState(false)
  const [busy, setBusy] = useState(false)
  const linked =
    linear.view.status === 'ready'
      ? (linear.view.value.workspaces.find(
          (entry) => entry.workspaceId === workspace.workspaceId
        ) ?? null)
      : null
  const people = useConnectorPeople({
    bot,
    accessBot: props.accessBot,
    people: linearMembersOf(bot.members, workspace.workspaceId),
    requests: (props.access?.requests ?? []).filter(
      (request) => request.source === 'linear' && request.workspaceId === workspace.workspaceId
    ),
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
  const place = workspace.workspaceName

  if (people.overlay) {
    return people.overlay
  }
  if (pickingDefault && linked) {
    return (
      <ConnectorDefaultBotPage
        bots={props.hostBots.filter((other) =>
          botLinearWorkspaces(other).some((entry) => entry.workspaceId === workspace.workspaceId)
        )}
        current={linked.defaultBotId}
        online={props.online}
        banner={props.banner}
        onBack={() => setPickingDefault(false)}
        onPick={(botId) => {
          setPickingDefault(false)
          const client = props.client
          if (!client) {
            return
          }
          void slackCall(
            () =>
              linearSetDefaultBot.request(
                client,
                { workspaceId: workspace.workspaceId, botId },
                { failWhenDisconnected: true }
              ),
            linearSetDefaultBot.interpret
          ).then(async (result) => {
            if (!result.ok) {
              props.showToast(
                connectorAccountErrorMessage('linear', result.error, hostName, t),
                2400
              )
            }
            await linear.refresh()
          })
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
          'bots.linear.connection.removeNote',
          'People in {{workspace}} can no longer hand it issues, and its Linear people are cleared. Orca stays installed there.',
          { workspace: linearWorkspaceLabel(workspace.workspaceName, workspace.urlKey) }
        )}
        confirmLabel={t('bots.linear.connection.removeConfirm', 'Remove')}
        destructive
        onCancel={() => setConfirmRemove(false)}
        onConfirm={() => {
          setConfirmRemove(false)
          setBusy(true)
          void saveRemovingMembers(
            props.save,
            bot.members.filter(
              (member) =>
                botMemberSource(member) === 'linear' && member.workspaceId === workspace.workspaceId
            ),
            {
              linearWorkspaces: botLinearWorkspaces(bot).filter(
                (entry) => entry.workspaceId !== workspace.workspaceId
              )
            }
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

  const fix =
    linear.view.status !== 'ready'
      ? null
      : !linked
        ? t('settings.bots.linearStatus.unlinked', 'Not linked')
        : !linked.installed
          ? t('settings.bots.linearStatus.notInstalled', 'Orca not installed')
          : null
  const defaultBot = linked?.defaultBotId
    ? (props.hostBots.find((other) => other.id === linked.defaultBotId)?.name ??
      t('bots.connect.otherComputer', 'A bot on another computer'))
    : t('bots.connect.askEachTime', 'Ask which bot')
  return (
    <>
      <SheetHeader
        title={BOT_CONNECTOR_NAMES.linear}
        subtitle={place}
        onBack={{ label: t('bots.connectors.back', 'Back to Connectors'), onPress: props.onBack }}
        trailingButtons={
          <NavBarButton
            ref={menuAnchor}
            icon={Ellipsis}
            accessibilityLabel={t('bots.connector.actions', '{{name}} actions', {
              name: BOT_CONNECTOR_NAMES.linear
            })}
            onPress={() => setMenuOpen(true)}
          />
        }
      />
      {props.banner}
      <SettingsNote>
        {t(
          'bots.linear.howToAskPlain',
          'Mention @Orca {{handle}} on an issue, or add the label bot:{{handle}}.',
          { handle: bot.folder }
        )}
      </SettingsNote>
      {fix ? (
        <SettingsSection>
          <ListRow
            title={t('bots.linear.connection.finishSetup', 'Finish setup')}
            value={fix}
            navigates
            disabled={!props.online}
            onPress={() => props.onSetUp(workspace.workspaceId)}
          />
        </SettingsSection>
      ) : null}
      {linear.view.status === 'failed' ? (
        <SettingsNote error>
          {connectorAccountErrorMessage('linear', linear.view.error, hostName, t)}
        </SettingsNote>
      ) : null}
      {linked ? (
        <SettingsSection title={t('bots.connect.account', 'Account')}>
          <ListRow
            title={t('bots.connect.linkedAs', 'Linked as')}
            value={linked.userName || linked.userId}
          />
          <ListRow
            title={t('bots.connect.defaultBot', 'Default bot for my requests')}
            value={defaultBot}
            navigates
            disabled={!props.online}
            onPress={() => setPickingDefault(true)}
          />
        </SettingsSection>
      ) : null}
      {people.section}
      <SettingsSection>
        <ListRow
          title={t('bots.connector.removeFrom', 'Remove from {{place}}…', { place })}
          destructive
          disabled={!props.online || busy}
          accessibilityRole="button"
          onPress={() => setConfirmRemove(true)}
        />
      </SettingsSection>
      <PullDownMenu
        visible={menuOpen}
        anchorRef={menuAnchor}
        onClose={() => setMenuOpen(false)}
        groups={[
          [
            {
              label: t('bots.connectors.addAnotherWorkspace', 'Add another workspace'),
              icon: Plus,
              disabled: !props.online,
              onPress: () => props.onSetUp(undefined)
            }
          ]
        ]}
      />
    </>
  )
}
