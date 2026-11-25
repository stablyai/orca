// What the Slack, Linear and GitHub pages share: Who can ask on one workspace (its waiting requests and
// people), the hand-off while a sign-in finishes on the computer or in its tab here, and the default bot picker.
import { useEffect, useState, type ReactNode } from 'react'
import { ActivityIndicator, AppState } from 'react-native'
import { ArrowUpRight } from 'lucide-react-native'
import type { BotMember } from '../../../../src/shared/bot-types'
import type { ConnectorAccessRequest } from '../../../../src/shared/connector-bot-access-contract'
import { ListRow } from '../../components/list/ListGroup'
import { SheetHeader } from '../../components/nav-bar/SheetHeader'
import { ConfirmContent } from '../../components/sheets/ConfirmModal'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { useBackClaim } from '../../navigation/use-back-claim'
import { SettingsSection } from '../../settings/settings-screen-frame'
import { colors } from '../../theme/mobile-theme'
import { mobileBotAccessCopy } from '../mobile-bot-access-copy'
import type { PhoneBot } from '../host-bots-operations'
import { MobileBotAccessDecisionContent } from '../MobileBotAccessDecision'
import {
  MobileWhoCanAskOwnerFace,
  MobileWhoCanAskPersonRow,
  MobileWhoCanAskRequestRow,
  MobileWhoCanAskReview,
  WHO_FACE_INSET,
  whoCanAskName
} from '../MobileWhoCanAskRows'
import type { BotAccessRequests } from '../use-bot-access-requests'

/**
 * One workspace's Who can ask: its requests, then You and its people, each removable. `overlay` replaces
 * the page while a removal or a grant is confirmed; `dismiss` closes it, saying whether one was open.
 */
export function useConnectorPeople(props: {
  bot: PhoneBot
  accessBot: Parameters<typeof MobileBotAccessDecisionContent>[0]['bot']
  people: readonly BotMember[]
  requests: readonly ConnectorAccessRequest[]
  access: BotAccessRequests | null
  online: boolean
  removeMember: (member: BotMember) => void
}): { overlay: ReactNode; section: ReactNode; dismiss: () => boolean } {
  const t = useMobileTranslation()
  const { bot, access } = props
  const [removing, setRemoving] = useState<BotMember | null>(null)
  const [granting, setGranting] = useState<ConnectorAccessRequest | null>(null)
  const dismiss = () => {
    const open = removing !== null || granting !== null
    setRemoving(null)
    setGranting(null)
    return open
  }
  const overlay =
    granting && access ? (
      <MobileWhoCanAskReview
        request={granting}
        bot={props.accessBot}
        busy={access.deciding || !props.online}
        onDecide={(decision) => void access.decide(granting, decision)}
        onClose={() => setGranting(null)}
      />
    ) : removing ? (
      <ConfirmContent
        title={t('bots.settings.removeConfirmTitle', 'Remove {{name}}?', {
          name: whoCanAskName(removing)
        })}
        message={t(
          'bots.settings.removeConfirmMessage',
          '{{name}} can no longer ask {{botName}}.',
          { name: whoCanAskName(removing), botName: bot.name }
        )}
        confirmLabel={t('bots.settings.remove', 'Remove')}
        destructive
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          setRemoving(null)
          props.removeMember(removing)
        }}
      />
    ) : null
  const deciding = access?.deciding === true || !props.online
  const section = (
    <>
      {props.requests.length > 0 && access ? (
        <SettingsSection title={mobileBotAccessCopy(t, 'heading')} separatorInset={WHO_FACE_INSET}>
          {props.requests.map((request) => (
            <MobileWhoCanAskRequestRow
              key={request.requestId}
              request={request}
              busy={deciding}
              onReview={() => setGranting(request)}
              onDecline={() => void access.decide(request, 'declined')}
            />
          ))}
        </SettingsSection>
      ) : null}
      <SettingsSection
        title={t('bots.settings.whoCanAskName', 'Who can ask {{name}}', { name: bot.name })}
        separatorInset={WHO_FACE_INSET}
      >
        <ListRow
          leading={<MobileWhoCanAskOwnerFace />}
          title={t('bots.settings.you', 'You')}
          value={t('bots.settings.owner', 'Owner')}
        />
        {props.people.map((member) => (
          <MobileWhoCanAskPersonRow
            key={`${member.id}:${member.workspaceId ?? ''}`}
            member={member}
            busy={!props.online}
            onRemove={() => setRemoving(member)}
          />
        ))}
      </SettingsSection>
    </>
  )
  return { overlay, section, dismiss }
}

// Following the host for a change made elsewhere (an install, an approval): often at first, then less,
// then not at all, as the desktop's connector-host-state does.
const FOLLOW_FAST_MS = 5_000
const FOLLOW_SLOW_MS = 30_000
const FOLLOW_FAST_FOR_MS = 2 * 60_000
const FOLLOW_FOR_MS = 10 * 60_000

/** Reads the host again while `on`, and whenever the phone comes back from the browser. */
export function useFollowHost(on: boolean, refresh: () => Promise<void>): void {
  useEffect(() => {
    if (!on) {
      return
    }
    const since = Date.now()
    let timer: ReturnType<typeof setTimeout>
    const next = () => {
      const age = Date.now() - since
      if (age < FOLLOW_FOR_MS) {
        timer = setTimeout(
          () => {
            void refresh()
            next()
          },
          age < FOLLOW_FAST_FOR_MS ? FOLLOW_FAST_MS : FOLLOW_SLOW_MS
        )
      }
    }
    next()
    const back = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        void refresh()
      }
    })
    return () => {
      clearTimeout(timer)
      back.remove()
    }
  }, [on, refresh])
}

/** Linear's or GitHub's sign-in, open in Orca's browser on the host: the phone waits until it ends. */
export function ConnectorHandoff(props: {
  hostName: string
  /** What to do there, e.g. pick the workspace and choose Authorize. */
  message: string
  /** Said once the wait has run long, e.g. Linear's likely error page. */
  stuck?: string | null
  /** Shows the sign-in on this phone; null where the host can't stream it here. */
  onOpenPage: (() => void) | null
}) {
  const t = useMobileTranslation()
  return (
    <SettingsSection
      first
      footer={props.stuck ?? t('bots.connect.updatesWhenDone', 'This updates when you finish.')}
    >
      <ListRow
        leading={<ActivityIndicator size="small" color={colors.textSecondary} />}
        title={t('bots.connect.continueOn', 'Continue on {{host}}', { host: props.hostName })}
        wrapTitle
        subtitle={props.message}
      />
      {props.onOpenPage ? (
        <ListRow
          leading={<ArrowUpRight size={18} color={colors.accentBlue} />}
          accent
          title={t('bots.connect.openSignInPage', 'Open sign-in page')}
          accessibilityRole="link"
          onPress={props.onOpenPage}
        />
      ) : null}
    </SettingsSection>
  )
}

/** "Default bot for my requests": Ask which bot, or one of the host's bots on this service. */
export function ConnectorDefaultBotPage(props: {
  bots: readonly { id: string; name: string }[]
  current: string | null
  online: boolean
  banner: ReactNode
  onPick: (botId: string | null) => void
  onBack: () => void
}) {
  const t = useMobileTranslation()
  useBackClaim(() => {
    props.onBack()
    return true
  })
  const choices = [
    { id: null, name: t('bots.connect.askEachTime', 'Ask which bot') },
    ...props.bots,
    // A default the host's list doesn't have is a bot on another computer.
    ...(props.current && !props.bots.some((bot) => bot.id === props.current)
      ? [{ id: props.current, name: t('bots.connect.otherComputer', 'A bot on another computer') }]
      : [])
  ]
  return (
    <>
      <SheetHeader
        title={t('bots.connect.defaultBot', 'Default bot for my requests')}
        onBack={{ label: t('bots.connectors.backShort', 'Back'), onPress: props.onBack }}
      />
      {props.banner}
      <SettingsSection first>
        {choices.map((choice) => (
          <ListRow
            key={choice.id ?? 'ask'}
            title={choice.name}
            selected={choice.id === props.current}
            disabled={!props.online}
            accessibilityRole="radio"
            onPress={() => props.onPick(choice.id)}
          />
        ))}
      </SettingsSection>
    </>
  )
}
