// Connect Slack's pick and problem steps on the phone, as the desktop's BotSlackSetupDialog draws its
// ConnectorWorkspacePicker and SlackSetupProblemStep.
import { useEffect, useState } from 'react'
import { ArrowUpRight } from 'lucide-react-native'
import { botSlackApps } from '../../../../src/shared/bot-types'
import { slackSetupProblemCode } from '../../../../src/shared/bots/slack-setup-problem-details'
import { slackTeamState } from '../../../../src/shared/connector-bot-slack-contract'
import { ListRow } from '../../components/list/ListGroup'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { SettingsSection } from '../../settings/settings-screen-frame'
import { colors } from '../../theme/mobile-theme'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import type { PhoneBot } from '../host-bots-operations'
import { MobileConnectorLogo } from '../MobileConnectorSourceIcon'
import { readSlack } from './use-phone-bot-slack'

/** Each workspace's name as one of the host's bots there reads it (one read per bot, again once the
 *  phone is back online); its id until known. */
function useSlackTeamNames(
  client: RpcClient | null,
  hostBots: readonly PhoneBot[],
  teamIds: readonly string[],
  online: boolean
): ReadonlyMap<string, string> {
  const [names, setNames] = useState<ReadonlyMap<string, string>>(new Map())
  // The first bot in each workspace, one line of `botId teamId…` each, so the effect reruns only when it changes.
  const readers = new Map<string, string[]>()
  for (const teamId of teamIds) {
    const botId = hostBots.find((bot) => botSlackApps(bot).some((app) => app.teamId === teamId))?.id
    if (botId) {
      readers.set(botId, [...(readers.get(botId) ?? []), teamId])
    }
  }
  const key = [...readers].map(([botId, teams]) => [botId, ...teams].join(' ')).join('\n')
  useEffect(() => {
    if (!client || !online) {
      return
    }
    let current = true
    for (const [botId, ...teams] of key ? key.split('\n').map((line) => line.split(' ')) : []) {
      void readSlack(client, botId).then((read) => {
        if (!current || read?.status !== 'ready') {
          return
        }
        const found = teams.flatMap((teamId) => {
          const team = slackTeamState(read.slack, teamId)
          return team.state === 'installed' && team.teamName
            ? [[teamId, team.teamName] as const]
            : []
        })
        setNames((shown) => new Map([...shown, ...found]))
      })
    }
    return () => {
      current = false
    }
  }, [client, online, key])
  return names
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
  const names = useSlackTeamNames(props.client, props.hostBots, props.teamIds, props.online)
  return (
    <SettingsSection first title={t('bots.slack.setup.pick', 'Choose a Slack workspace.')}>
      {props.teamIds.map((teamId) => (
        <ListRow
          key={teamId}
          leading={<MobileConnectorLogo source="slack" size={20} />}
          title={names.get(teamId) ?? teamId}
          navigates
          disabled={!props.online}
          onPress={() => props.onPick(teamId)}
        />
      ))}
      <ListRow
        leading={<ArrowUpRight size={18} color={colors.accentBlue} />}
        accent
        title={t('bots.slack.setup.another', 'Connect another workspace')}
        disabled={!props.online}
        onPress={props.onAnother}
      />
    </SettingsSection>
  )
}

/** What happened, one way forward, and under Details the codes for whoever reads them to support. */
export function SlackProblemStep(props: {
  kind: 'expired' | 'other-user'
  teamId: string
  client: RpcClient | null
  hostBots: readonly PhoneBot[]
  botName: string
  hostName: string
  online: boolean
  onNewLink: () => void
}) {
  const t = useMobileTranslation()
  const names = useSlackTeamNames(props.client, props.hostBots, [props.teamId], props.online)
  const other = props.kind === 'other-user'
  return (
    <>
      <SettingsSection first>
        <ListRow
          leading={<MobileConnectorLogo source="slack" size={20} />}
          title={
            other
              ? t(
                  'bots.slack.problem.otherUser',
                  'A different Slack account approved the connection.'
                )
              : t('bots.slack.problem.expired', 'Slack sign-in didn’t finish.')
          }
          wrapTitle
          subtitle={
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
          subtitleLines={5}
        />
        <ListRow
          leading={<ArrowUpRight size={18} color={colors.accentBlue} />}
          accent
          title={t('bots.slack.setup.newLink', 'Get a new link')}
          accessibilityRole="link"
          disabled={!props.online}
          onPress={props.onNewLink}
        />
      </SettingsSection>
      <SettingsSection title={t('common.details', 'Details')}>
        <ListRow
          title={t('bots.slack.problem.code', 'Code')}
          value={slackSetupProblemCode({ kind: props.kind, teamId: props.teamId })}
        />
        <ListRow title={t('bots.slack.problem.computer', 'Computer')} value={props.hostName} />
        <ListRow
          title={t('bots.slack.problem.workspace', 'Workspace')}
          value={names.get(props.teamId) ?? props.teamId}
        />
      </SettingsSection>
    </>
  )
}
