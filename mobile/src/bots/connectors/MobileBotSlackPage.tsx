// One Slack workspace's page in Connectors: the desktop's BotSlackCard and BotSlackSection. How to ask, its
// waiting requests and people, who replies post as, and the card's menu and Remove.
import { BOT_CONNECTOR_NAMES } from '../../../../src/shared/bots/bot-templates'
import { BOTS_SLACK_POST_AS_RUNTIME_CAPABILITY } from '../../../../src/shared/bot-runtime-capabilities'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Ellipsis, ExternalLink, Plus, RefreshCw } from '../../components/icons/app-icons'
import { botMembersFrom, slackMembersOf, type BotMember } from '../../../../src/shared/bot-types'
import { ListRow } from '../../components/list/ListGroup'
import { NavBarButton } from '../../components/nav-bar/NavBarButton'
import { NativeMenu } from '../../components/menu/NativeMenu'
import { SheetHeader } from '../../components/nav-bar/SheetHeader'
import { ConfirmContent } from '../../components/sheets/ConfirmModal'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { useBackClaim } from '../../navigation/use-back-claim'
import { useRouteCapability } from '../../worktree/execution-hosts/use-route-capability'
import { openExternalLink } from '../../platform/external-links/external-link'
import { SettingsNote, SettingsSection } from '../../settings/settings-screen-frame'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import type { PhoneBot } from '../host-bots-operations'
import type { MobileBotAccessDecisionContent } from '../MobileBotAccessDecision'
import type { BotAccessRequests } from '../use-bot-access-requests'
import { slackCall, slackRemove } from './bot-slack-operations'
import { slackErrorMessage, slackRowFace } from './mobile-slack-copy'
import { slackTeamState } from '../../../../src/shared/connector-bot-slack-contract'
import type { PhoneSlackView } from './use-phone-bot-slack'
import { useConnectorPeople } from './MobileConnectorAccountParts'
import { MobileSlackPostAsPage, slackPosterNames } from './MobileSlackPostAsPage'

export function MobileBotSlackPage(props: {
  client: RpcClient | null
  bot: PhoneBot
  /** The bot shaped for the access-request confirm. */
  accessBot: Parameters<typeof MobileBotAccessDecisionContent>[0]['bot']
  /** None: a bot whose app was removed but whose Slack people remain. */
  teamId: string | undefined
  slack: { view: PhoneSlackView; refresh: () => Promise<PhoneSlackView> }
  access: BotAccessRequests | null
  hostName: string
  online: boolean
  banner: ReactNode
  showToast: (message: string, durationMs?: number) => void
  removeMember: (member: BotMember) => void
  onBack: () => void
  /** Finish, update or add another workspace: Connect Slack. */
  onSetUp: (teamId: string | undefined) => void
}) {
  const t = useMobileTranslation()
  const { bot, teamId, slack } = props
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [postAsOpen, setPostAsOpen] = useState(false)
  // An older host keeps Post as read-only: it refuses bots.slack.setPostAs from a phone.
  const canPostAs = useRouteCapability(BOTS_SLACK_POST_AS_RUNTIME_CAPABILITY)
  const [busy, setBusy] = useState(false)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const face = slackRowFace(slack.view, teamId, props.hostName, t)
  const team = slack.view.status === 'ready' ? slackTeamState(slack.view.slack, teamId) : null
  const installed = team?.state === 'installed' ? team : null
  const postAs = installed?.postAs
  // A workspace's page can also remove an app that was never installed.
  const removable = installed ?? (teamId !== undefined && team && 'teamId' in team ? team : null)
  const place = face.workspace ?? BOT_CONNECTOR_NAMES.slack
  const people = useConnectorPeople({
    bot,
    accessBot: props.accessBot,
    people:
      teamId === undefined ? botMembersFrom(bot.members, 'slack') : slackMembersOf(bot, teamId),
    // As the desktop: requests wait on an installed workspace, where granting lets them ask.
    requests: installed
      ? (props.access?.requests ?? []).filter(
          (request) => request.source === 'slack' && request.workspaceId === installed.teamId
        )
      : [],
    access: props.access,
    online: props.online,
    removeMember: props.removeMember
  })
  useBackClaim(() => {
    if (!people.dismiss() && !confirmRemove) {
      props.onBack()
    }
    setConfirmRemove(false)
    return true
  })

  if (people.overlay) {
    return people.overlay
  }
  if (postAsOpen && canPostAs && installed && postAs) {
    return (
      <MobileSlackPostAsPage
        client={props.client}
        botId={bot.id}
        installed={{ ...installed, postAs }}
        hostName={props.hostName}
        online={props.online}
        banner={props.banner}
        showToast={props.showToast}
        refresh={slack.refresh}
        onBack={() => setPostAsOpen(false)}
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
          'bots.slack.connection.removeNote',
          'Removing stops new work from Slack. It does not delete the app in Slack.'
        )}
        confirmLabel={t('bots.slack.connection.removeConfirm', 'Remove')}
        destructive
        onCancel={() => setConfirmRemove(false)}
        onConfirm={() => {
          setConfirmRemove(false)
          const client = props.client
          const removeTeam = teamId
          if (!client || removeTeam === undefined) {
            return
          }
          setBusy(true)
          void slackCall(
            () =>
              slackRemove.request(
                client,
                // The page's own workspace: without one the host removes every workspace.
                { botId: bot.id, teamId: removeTeam },
                { failWhenDisconnected: true }
              ),
            slackRemove.interpret
          ).then(async (result) => {
            setBusy(false)
            if (!result.ok) {
              props.showToast(slackErrorMessage(result.error, props.hostName, t), 2400)
            }
            await slack.refresh()
            // Left meanwhile: the page the owner moved to stays.
            if (result.ok && alive.current) {
              props.onBack()
            }
          })
        }}
      />
    )
  }

  const fixLabel =
    face.next === 'retry'
      ? t('bots.slack.setup.retry', 'Try again')
      : face.next === 'add'
        ? t('bots.slack.connection.add', 'Add to Slack')
        : face.next === 'finish'
          ? t('bots.slack.connection.finish', 'Finish setup')
          : face.next === 'update'
            ? t('bots.slack.connection.update', 'Update in Slack')
            : null
  const menu = [
    ...(installed
      ? [
          {
            label: t('bots.connectors.addAnotherWorkspace', 'Add another workspace'),
            icon: Plus,
            disabled: !props.online,
            onPress: () => props.onSetUp(undefined)
          },
          {
            label: t('bots.slack.connection.appSettings', 'Slack app settings'),
            icon: ExternalLink,
            onPress: () =>
              openExternalLink(`https://api.slack.com/apps/${encodeURIComponent(installed.appId)}`)
          }
        ]
      : []),
    ...(installed?.updateAvailable && !installed.updateNeeded
      ? [
          {
            label: t('bots.slack.connection.updatePermissions', 'Update Slack permissions…'),
            icon: RefreshCw,
            disabled: !props.online,
            onPress: () => props.onSetUp(installed.teamId)
          }
        ]
      : [])
  ]
  const posters = installed ? slackPosterNames(installed, props.hostName, t) : null
  const pendingPostAs = installed?.postAsPending !== undefined && installed.postAsPending !== postAs
  return (
    <>
      <SheetHeader
        title={BOT_CONNECTOR_NAMES.slack}
        subtitle={face.workspace ?? undefined}
        onBack={{ label: t('bots.connectors.back', 'Back to Connectors'), onPress: props.onBack }}
        trailingButtons={
          menu.length > 0 ? (
            <NativeMenu groups={[menu]}>
              {(openMenu) => (
                <NavBarButton
                  icon={Ellipsis}
                  accessibilityLabel={t('bots.connector.actions', '{{name}} actions', {
                    name: BOT_CONNECTOR_NAMES.slack
                  })}
                  onPress={openMenu}
                />
              )}
            </NativeMenu>
          ) : undefined
        }
      />
      {props.banner}
      {installed ? (
        <SettingsNote>
          {t('bots.slack.mentionLinePlain', 'Mention @{{name}} in a channel or DM.', {
            name: bot.name
          })}
        </SettingsNote>
      ) : teamId !== undefined ? (
        <SettingsNote>{face.description}</SettingsNote>
      ) : null}
      {fixLabel && teamId !== undefined ? (
        <SettingsSection>
          <ListRow
            title={fixLabel}
            value={face.status?.label}
            navigates={face.next !== 'retry'}
            disabled={!props.online}
            onPress={() => (face.next === 'retry' ? void slack.refresh() : props.onSetUp(teamId))}
          />
        </SettingsSection>
      ) : null}
      {people.section}
      {posters && postAs ? (
        <SettingsSection title={t('bots.slack.replies', 'Replies')}>
          <ListRow
            title={t('bots.slack.postAs.title', 'Post as')}
            subtitle={
              !canPostAs
                ? t('bots.slack.postAs.changeOn', 'Change it on {{host}}', { host: props.hostName })
                : pendingPostAs
                  ? t('bots.slack.setup.waiting', 'Waiting for Slack…')
                  : undefined
            }
            value={posters[postAs]}
            navigates={canPostAs}
            onPress={canPostAs ? () => setPostAsOpen(true) : undefined}
          />
        </SettingsSection>
      ) : null}
      {removable && teamId !== undefined ? (
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
