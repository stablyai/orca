// What the Slack, Linear and GitHub pages share: Who can ask on one workspace (its waiting requests and
// people), the hand-off while a sign-in finishes on the computer, and the default bot picker.
import { useEffect, useState, type ReactNode } from 'react'
import { ActivityIndicator, AppState, Text, View } from 'react-native'
import { Laptop } from '../../components/icons/app-icons'
import type { BotMember } from '../../../../src/shared/bot-types'
import { accessRequestPerson } from '../../../../src/shared/bots/bot-access-request'
import type { ConnectorAccessRequest } from '../../../../src/shared/connector-bot-access-contract'
import { MobileStateButton, MobileStateView } from '../../components/feedback/MobileStateView'
import { ListRow } from '../../components/list/ListGroup'
import { SheetHeader } from '../../components/nav-bar/SheetHeader'
import { ConfirmContent } from '../../components/sheets/ConfirmModal'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { useBackClaim } from '../../navigation/use-back-claim'
import { SettingsNote, SettingsSection } from '../../settings/settings-screen-frame'
import { colors, spacing } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { accessRequestGrant, accessRequestLine } from '../bot-access-request-copy'
import { mobileBotAccessCopy } from '../mobile-bot-access-copy'
import type { PhoneBot } from '../host-bots-operations'
import { MobileBotAccessDecisionContent } from '../MobileBotAccessDecision'
import { optionStyles } from '../mobile-bot-option-styles'
import { MobileBotTextButton } from '../MobileBotTextButton'
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
      <MobileBotAccessDecisionContent
        grant={accessRequestGrant(granting)}
        bot={props.accessBot}
        onGrant={() => void access.decide(granting, 'granted')}
        onClose={() => setGranting(null)}
      />
    ) : removing ? (
      <ConfirmContent
        title={t('bots.settings.removeConfirmTitle', 'Remove {{name}}?', { name: removing.name })}
        message={t(
          'bots.settings.removeConfirmMessage',
          '{{name}} can no longer ask {{botName}}.',
          { name: removing.name, botName: bot.name }
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
        <SettingsSection title={mobileBotAccessCopy(t, 'heading')}>
          {props.requests.map((request) => {
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
                      disabled={deciding}
                      onPress={() => void access.decide(request, 'declined')}
                    />
                    <MobileBotTextButton
                      label={mobileBotAccessCopy(t, 'review')}
                      accessibilityLabel={t('bots.settings.reviewName', 'Review {{name}}', {
                        name: person
                      })}
                      disabled={deciding}
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
        {props.people.map((member) => (
          <ListRow
            key={`${member.id}:${member.workspaceId ?? ''}`}
            title={member.name}
            accessory={
              <MobileBotTextButton
                label={t('bots.settings.remove', 'Remove')}
                accessibilityLabel={t('bots.settings.removeName', 'Remove {{name}}', {
                  name: member.name
                })}
                disabled={!props.online}
                onPress={() => setRemoving(member)}
              />
            }
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
  message: string
  waiting: string
  /** Said once the wait has run long, e.g. Linear's likely error page. */
  stuck?: string | null
  onCancel: () => void
}) {
  const t = useMobileTranslation()
  return (
    <>
      <MobileStateView
        iconElement={<Laptop size={28} color={colors.textPrimary} strokeWidth={1.75} />}
        title={t('bots.connect.continueOn', 'Continue on {{host}}', { host: props.hostName })}
        message={props.message}
      >
        <View style={styles.waiting}>
          <ActivityIndicator size="small" color={colors.textSecondary} />
          <Text style={styles.waitingText}>{props.waiting}</Text>
        </View>
        <MobileStateButton label={t('bots.connect.cancel', 'Cancel')} onPress={props.onCancel} />
      </MobileStateView>
      {props.stuck ? <SettingsNote>{props.stuck}</SettingsNote> : null}
    </>
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

const styles = themedStyleSheet(() => ({
  waiting: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    marginBottom: spacing.md
  },
  waitingText: { flexShrink: 1, color: colors.textSecondary, fontSize: 13 }
}))
