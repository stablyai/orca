// Who a reply typed at the bot's computer posts as in one Slack workspace: the desktop's BotSlackPostAs,
// each choice drawn as the post it makes. A change waits on whoever set the bot's Slack up approving it
// in Slack; picking the posted choice again cancels it.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { ActivityIndicator } from 'react-native'
import { ArrowUpRight, Laptop } from 'lucide-react-native'
import type {
  ConnectorBotSlackState,
  SlackPostAs
} from '../../../../src/shared/connector-bot-slack-contract'
import { ListRow } from '../../components/list/ListGroup'
import { SheetHeader } from '../../components/nav-bar/SheetHeader'
import type { Translate } from '../../i18n/mobile-i18n'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { useBackClaim } from '../../navigation/use-back-claim'
import { openExternalLink } from '../../platform/external-links/external-link'
import { SettingsSection } from '../../settings/settings-screen-frame'
import { colors } from '../../theme/mobile-theme'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { MobileFaceSlot, MobilePersonFace, WHO_FACE_INSET } from '../MobileWhoCanAskRows'
import { slackCall, slackSetPostAs } from './bot-slack-operations'
import { useFollowHost } from './MobileConnectorAccountParts'
import { slackErrorMessage } from './mobile-slack-copy'

type Installed = Extract<ConnectorBotSlackState, { state: 'installed' }>

/** What each choice posts under, as the desktop names it. */
export function slackPosterNames(
  installed: Installed,
  hostName: string,
  t: Translate
): Record<SlackPostAs, string> {
  return {
    person: installed.poster?.name || t('bots.slack.postAs.orcaUser', 'Orca user'),
    computer: installed.computerName || hostName
  }
}

export function MobileSlackPostAsPage(props: {
  client: RpcClient | null
  botId: string
  installed: Installed & { postAs: SlackPostAs }
  hostName: string
  online: boolean
  banner: ReactNode
  showToast: (message: string, durationMs?: number) => void
  refresh: () => Promise<unknown>
  onBack: () => void
}) {
  const t = useMobileTranslation()
  const { installed, refresh } = props
  // The pick before it is sent for approval.
  const [asked, setAsked] = useState<SlackPostAs | null>(null)
  const [opened, setOpened] = useState(false)
  const [busy, setBusy] = useState(false)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  useBackClaim(() => {
    props.onBack()
    return true
  })
  const follow = useCallback(async () => {
    await refresh()
  }, [refresh])
  // Once the host reports the sent change waiting or applied, it speaks for it, so a change elsewhere shows here.
  if (asked !== null && (installed.postAs === asked || installed.postAsPending === asked)) {
    setAsked(null)
  }
  const current = installed.postAs
  const waiting =
    [asked, installed.postAsPending].find(
      (choice): choice is SlackPostAs =>
        choice !== undefined && choice !== null && choice !== current
    ) ?? null
  const names = slackPosterNames(installed, props.hostName, t)
  // Its link was opened here or earlier: the host is followed until Slack answers.
  const sent = waiting !== null && (opened || installed.postAsPending === waiting)
  useFollowHost(sent, follow)

  /** One write and the read after it, the rows busy throughout so a tap never acts on a stale read. */
  const write = async (request: { postAs: SlackPostAs } | { cancel: true }) => {
    const client = props.client
    if (!client) {
      return
    }
    setBusy(true)
    const result = await slackCall(
      () =>
        slackSetPostAs.request(
          client,
          { botId: props.botId, teamId: installed.teamId, ...request },
          { failWhenDisconnected: true }
        ),
      slackSetPostAs.interpret
    )
    if (!result.ok) {
      props.showToast(slackErrorMessage(result.error, props.hostName, t), 2400)
    }
    const link = result.ok && result.value && 'authorizeUrl' in result.value ? result.value : null
    // Left meanwhile: no link opens from a page that is gone.
    if (link && alive.current) {
      setOpened(true)
      openExternalLink(link.authorizeUrl)
    }
    await refresh()
    setBusy(false)
  }

  const pick = async (choice: SlackPostAs) => {
    const wasSent = opened || installed.postAsPending !== undefined
    setOpened(false)
    if (choice !== current) {
      setAsked(choice)
      return
    }
    setAsked(null)
    if (wasSent) {
      await write({ cancel: true })
    }
  }

  const face = (choice: SlackPostAs) =>
    choice === 'person' ? (
      <MobilePersonFace
        id={names.person}
        name={names.person}
        picture={installed.poster?.avatarUrl ?? undefined}
      />
    ) : (
      <MobilePersonFace id="" name="" mark={Laptop} />
    )

  return (
    <>
      <SheetHeader
        title={t('bots.slack.postAs.title', 'Post as')}
        subtitle={installed.teamName}
        onBack={{ label: t('bots.connectors.backShort', 'Back'), onPress: props.onBack }}
      />
      {props.banner}
      <SettingsSection
        first
        radioGroup
        separatorInset={WHO_FACE_INSET}
        footer={t(
          'bots.slack.postAs.linePlain',
          'When you reply to a Slack thread from Orca, it posts as {{name}}.',
          { name: names[current] }
        )}
      >
        {(['person', 'computer'] as const).map((choice) => (
          <ListRow
            key={choice}
            leading={face(choice)}
            title={t('bots.slack.postAs.viaOrca', '{{name}} (via Orca)', { name: names[choice] })}
            subtitle={t('bots.slack.postAs.sample', 'Ship it after that')}
            selected={choice === (waiting ?? current)}
            disabled={!props.online}
            busy={busy}
            onPress={() => void pick(choice)}
          />
        ))}
      </SettingsSection>
      {waiting ? (
        <SettingsSection
          footer={
            installed.installerName
              ? t(
                  'bots.slack.postAs.waitingOn',
                  'Switching to {{name}} needs {{installer}} to approve in Slack.',
                  { name: names[waiting], installer: installed.installerName }
                )
              : t('bots.slack.postAs.waiting', 'Switching to {{name}} needs approval in Slack.', {
                  name: names[waiting]
                })
          }
        >
          <ListRow
            leading={
              <MobileFaceSlot>
                <ArrowUpRight size={18} color={colors.accentBlue} />
              </MobileFaceSlot>
            }
            accent
            title={t('bots.slack.postAs.approve', 'Approve in Slack')}
            subtitle={sent ? t('bots.slack.setup.waiting', 'Waiting for Slack…') : undefined}
            accessory={
              sent ? <ActivityIndicator size="small" color={colors.textSecondary} /> : undefined
            }
            accessibilityRole="link"
            disabled={!props.online}
            busy={busy}
            onPress={() => void write({ postAs: waiting })}
          />
        </SettingsSection>
      ) : null}
    </>
  )
}
