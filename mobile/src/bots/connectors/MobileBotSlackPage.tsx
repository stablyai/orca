// One Slack workspace's page in Connectors: the desktop's BotSlackCard and BotSlackSection. How to ask, its
// waiting requests and people, who replies post as (changed on the computer: bots.slack.setPostAs isn't on
// the phone's allowlist), and the card's menu and Remove.
import { BOT_CONNECTOR_NAMES } from '../../../../src/shared/bots/bot-templates'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { View } from 'react-native'
import { Ellipsis, ExternalLink, Plus, RefreshCw } from 'lucide-react-native'
import { botMembersFrom, slackMembersOf, type BotMember } from '../../../../src/shared/bot-types'
import { accessRequestPerson } from '../../../../src/shared/bots/bot-access-request'
import type { ConnectorAccessRequest } from '../../../../src/shared/connector-bot-access-contract'
import { ListRow } from '../../components/list/ListGroup'
import { NavBarButton } from '../../components/nav-bar/NavBarButton'
import { PullDownMenu } from '../../components/nav-bar/PullDownMenu'
import { SheetHeader } from '../../components/nav-bar/SheetHeader'
import { ConfirmContent } from '../../components/sheets/ConfirmModal'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { useBackClaim } from '../../navigation/use-back-claim'
import { openExternalLink } from '../../platform/external-links/external-link'
import { SettingsNote, SettingsSection } from '../../settings/settings-screen-frame'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { accessRequestLine } from '../bot-access-request-copy'
import { mobileBotAccessCopy } from '../mobile-bot-access-copy'
import type { PhoneBot } from '../host-bots-operations'
import { MobileBotAccessDecisionContent } from '../MobileBotAccessDecision'
import { optionStyles } from '../mobile-bot-option-styles'
import { MobileBotTextButton } from '../MobileBotTextButton'
import type { BotAccessRequests } from '../use-bot-access-requests'
import { slackCall, slackRemove } from './bot-slack-operations'
import { slackErrorMessage, slackRowFace } from './mobile-slack-copy'
import { slackTeamState } from '../../../../src/shared/connector-bot-slack-contract'
import type { PhoneSlackView } from './use-phone-bot-slack'

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
  const [menuOpen, setMenuOpen] = useState(false)
  const menuAnchor = useRef(null)
  const [confirm, setConfirm] = useState<
    { kind: 'remove' } | { kind: 'member'; member: BotMember } | null
  >(null)
  const [granting, setGranting] = useState<ConnectorAccessRequest | null>(null)
  const [busy, setBusy] = useState(false)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  useBackClaim(() => {
    if (confirm || granting) {
      setConfirm(null)
      setGranting(null)
    } else {
      props.onBack()
    }
    return true
  })
  const face = slackRowFace(slack.view, teamId, props.hostName, t)
  const team = slack.view.status === 'ready' ? slackTeamState(slack.view.slack, teamId) : null
  const installed = team?.state === 'installed' ? team : null
  // A workspace's page can also remove an app that was never installed.
  const removable = installed ?? (teamId !== undefined && team && 'teamId' in team ? team : null)
  const place = face.workspace ?? BOT_CONNECTOR_NAMES.slack
  const people =
    teamId === undefined ? botMembersFrom(bot.members, 'slack') : slackMembersOf(bot, teamId)
  // As the desktop: requests wait on an installed workspace, where granting lets them ask.
  const requests = installed
    ? (props.access?.requests ?? []).filter(
        (request) => request.source === 'slack' && request.workspaceId === installed.teamId
      )
    : []

  if (granting && props.access) {
    const access = props.access
    return (
      <MobileBotAccessDecisionContent
        request={granting}
        bot={props.accessBot}
        onGrant={() => void access.decide(granting, 'granted')}
        onClose={() => setGranting(null)}
      />
    )
  }
  if (confirm?.kind === 'member') {
    const { member } = confirm
    return (
      <ConfirmContent
        title={t('bots.settings.removeConfirmTitle', 'Remove {{name}}?', { name: member.name })}
        message={t(
          'bots.settings.removeConfirmMessage',
          '{{name}} can no longer ask {{botName}}.',
          {
            name: member.name,
            botName: bot.name
          }
        )}
        confirmLabel={t('bots.settings.remove', 'Remove')}
        destructive
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          setConfirm(null)
          props.removeMember(member)
        }}
      />
    )
  }
  if (confirm?.kind === 'remove') {
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
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          setConfirm(null)
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
  const poster =
    installed?.postAs === 'computer'
      ? (installed.computerName ?? props.hostName)
      : installed?.postAs === 'person'
        ? installed.poster?.name
        : undefined
  return (
    <>
      <SheetHeader
        title={BOT_CONNECTOR_NAMES.slack}
        subtitle={face.workspace ?? undefined}
        onBack={{ label: t('bots.connectors.back', 'Back to Connectors'), onPress: props.onBack }}
        trailingButtons={
          menu.length > 0 ? (
            <NavBarButton
              ref={menuAnchor}
              icon={Ellipsis}
              accessibilityLabel={t('bots.connector.actions', '{{name}} actions', {
                name: BOT_CONNECTOR_NAMES.slack
              })}
              onPress={() => setMenuOpen(true)}
            />
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
      {requests.length > 0 && props.access ? (
        <SettingsSection title={mobileBotAccessCopy(t, 'heading')}>
          {requests.map((request) => {
            const person = accessRequestPerson(request)
            return (
              <ListRow
                key={request.requestId}
                title={person}
                subtitle={accessRequestLine(request, t)}
                accessory={
                  <View style={optionStyles.rowActions}>
                    <MobileBotTextButton
                      label={mobileBotAccessCopy(t, 'decline')}
                      accessibilityLabel={t('bots.settings.declineName', 'Decline {{name}}', {
                        name: person
                      })}
                      disabled={props.access?.deciding || !props.online}
                      onPress={() => void props.access?.decide(request, 'declined')}
                    />
                    <MobileBotTextButton
                      label={mobileBotAccessCopy(t, 'review')}
                      accessibilityLabel={t('bots.settings.reviewName', 'Review {{name}}', {
                        name: person
                      })}
                      disabled={props.access?.deciding || !props.online}
                      onPress={() => setGranting(request)}
                    />
                  </View>
                }
              />
            )
          })}
        </SettingsSection>
      ) : null}
      <SettingsSection
        title={t('bots.settings.whoCanAskName', 'Who can ask {{name}}', { name: bot.name })}
      >
        <ListRow title={t('bots.settings.you', 'You')} value={t('bots.settings.owner', 'Owner')} />
        {people.map((member) => (
          <ListRow
            key={member.id}
            title={member.name}
            accessory={
              <MobileBotTextButton
                label={t('bots.settings.remove', 'Remove')}
                accessibilityLabel={t('bots.settings.removeName', 'Remove {{name}}', {
                  name: member.name
                })}
                disabled={!props.online}
                onPress={() => setConfirm({ kind: 'member', member })}
              />
            }
          />
        ))}
      </SettingsSection>
      {poster ? (
        <SettingsSection title={t('bots.slack.replies', 'Replies')}>
          <ListRow
            title={t('bots.slack.postAs.title', 'Post as')}
            subtitle={t('bots.slack.postAs.changeOn', 'Change it on {{host}}', {
              host: props.hostName
            })}
            value={poster}
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
            onPress={() => setConfirm({ kind: 'remove' })}
          />
        </SettingsSection>
      ) : null}
      <PullDownMenu
        visible={menuOpen}
        anchorRef={menuAnchor}
        onClose={() => setMenuOpen(false)}
        groups={[menu]}
      />
    </>
  )
}
