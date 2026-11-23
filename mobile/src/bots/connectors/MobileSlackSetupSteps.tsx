// Connect Slack's pick and problem steps on the phone, as the desktop's BotSlackSetupDialog draws its
// ConnectorWorkspacePicker and SlackSetupProblemStep.
import { useEffect, useState } from 'react'
import { ArrowUpRight } from 'lucide-react-native'
import { botSlackApps } from '../../../../src/shared/bot-types'
import { slackSetupProblemDetails } from '../../../../src/shared/bots/slack-setup-problem-details'
import { slackTeamState } from '../../../../src/shared/connector-bot-slack-contract'
import { MobileStateView } from '../../components/feedback/MobileStateView'
import { ListGroup, ListRow, SectionHeader } from '../../components/list/ListGroup'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { hostReadClient } from '../../query/host-read-client'
import { SettingsSection } from '../../settings/settings-screen-frame'
import { colors } from '../../theme/mobile-theme'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import type { PhoneBot } from '../host-bots-operations'
import { MobileConnectorSourceIcon } from '../MobileConnectorSourceIcon'
import { slackStateRead } from './bot-slack-operations'

/** The workspace's name as one of the host's bots there reads it; its id until known. */
function useSlackTeamName(
  client: RpcClient | null,
  hostBots: readonly PhoneBot[],
  teamId: string
): string {
  const [name, setName] = useState(teamId)
  const botId = hostBots.find((bot) => botSlackApps(bot).some((app) => app.teamId === teamId))?.id
  useEffect(() => {
    if (!client || !botId) {
      return
    }
    let current = true
    void slackStateRead
      .request(hostReadClient(client), { botId })
      .then((reply) => slackStateRead.interpret(reply))
      .then(
        (read) => {
          const team = read.ok ? slackTeamState(read.value, teamId) : null
          if (current && team?.state === 'installed' && team.teamName) {
            setName(team.teamName)
          }
        },
        () => {}
      )
    return () => {
      current = false
    }
  }, [client, botId, teamId])
  return name
}

function SlackTeamRow(props: {
  client: RpcClient | null
  hostBots: readonly PhoneBot[]
  teamId: string
  disabled: boolean
  onPick: () => void
}) {
  return (
    <ListRow
      leading={<MobileConnectorSourceIcon source="slack" size={20} />}
      title={useSlackTeamName(props.client, props.hostBots, props.teamId)}
      navigates
      disabled={props.disabled}
      onPress={props.onPick}
    />
  )
}

export function SlackPickStep(props: {
  client: RpcClient | null
  hostBots: readonly PhoneBot[]
  teamIds: readonly string[]
  online: boolean
  onPick: (teamId: string) => void
  onAnother: () => void
}) {
  const t = useMobileTranslation()
  return (
    <SettingsSection first title={t('bots.slack.setup.pick', 'Choose a Slack workspace.')}>
      {props.teamIds.map((teamId) => (
        <SlackTeamRow
          key={teamId}
          client={props.client}
          hostBots={props.hostBots}
          teamId={teamId}
          disabled={!props.online}
          onPick={() => props.onPick(teamId)}
        />
      ))}
      <ListRow
        leading={<ArrowUpRight size={18} color={colors.textPrimary} />}
        title={t('bots.slack.setup.another', 'Connect another workspace')}
        disabled={!props.online}
        onPress={props.onAnother}
      />
    </SettingsSection>
  )
}

/** What happened, one way forward, and the codes under Details for whoever reads them to support. */
export function SlackProblemStep(props: {
  kind: 'expired' | 'other-user'
  teamId: string
  botName: string
  hostName: string
  online: boolean
  onNewLink: () => void
}) {
  const t = useMobileTranslation()
  const [open, setOpen] = useState(false)
  const other = props.kind === 'other-user'
  return (
    <>
      <MobileStateView
        iconElement={<MobileConnectorSourceIcon source="slack" size={28} />}
        title={
          other
            ? t(
                'bots.slack.problem.otherUser',
                'A different Slack account approved the connection.'
              )
            : t('bots.slack.problem.expired', 'Slack sign-in didn’t finish.')
        }
        message={
          other
            ? t(
                'bots.slack.problem.otherUserNext',
                'Someone signed in to another Slack account approved the Slack link, so {{bot}} can’t act as you. Get a new link and approve it while signed in to your own Slack account.',
                { bot: props.botName }
              )
            : t(
                'bots.slack.problem.expiredNext',
                'The Slack link expired before anyone approved the connection.'
              )
        }
        action={
          props.online
            ? { label: t('bots.slack.setup.newLink', 'Get a new link'), onPress: props.onNewLink }
            : null
        }
      />
      <SectionHeader
        title={t('bots.slack.problem.details', 'Details')}
        expanded={open}
        onToggle={() => setOpen(!open)}
      />
      {open ? (
        <ListGroup>
          <ListRow
            title={slackSetupProblemDetails(
              { kind: props.kind, teamId: props.teamId },
              { botName: props.botName, hostName: props.hostName }
            )}
            wrapTitle
          />
        </ListGroup>
      ) : null}
    </>
  )
}
