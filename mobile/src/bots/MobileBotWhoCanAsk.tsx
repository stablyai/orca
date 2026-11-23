import type { ReactNode } from 'react'
import { Bot } from 'lucide-react-native'
import {
  botAccessPlace,
  botAccessCopy,
  type BotAccessCopyId
} from '../../../src/shared/bots/bot-access-copy'
import {
  botAccessAdvice,
  botAccessSummary,
  botStartingPermission,
  type BotAccessFix
} from '../../../src/shared/bots/bot-access-reach'
import type { BotMember } from '../../../src/shared/bot-types'
import { ConfirmContent } from '../components/sheets/ConfirmModal'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { ListRow } from '../components/list/ListGroup'
import { SettingsSection } from '../settings/settings-screen-frame'
import { colors } from '../theme/mobile-theme'
import { MobileBotTextButton } from './MobileBotTextButton'
import { phoneBotReachLines, type PhoneAccessBot } from './bot-access-request-copy'

// The phone can't read the app's chat permission, nor turn Google off: those stay on the desktop.
const PHONE_FIXES: Record<
  Exclude<BotAccessFix, 'google-off'>,
  { headingId: BotAccessCopyId; actionId: BotAccessCopyId }
> = {
  'only-me': { headingId: 'fixOnlyMe', actionId: 'fixOnlyMeAction' },
  'ask-for-approval': { headingId: 'fixAsk', actionId: 'fixAskAction' }
}

/** Another Slack app draws the desktop's bot mark; a person draws none. */
export function memberMark(member: BotMember): ReactNode {
  return member.kind === 'app' ? <Bot size={20} color={colors.textSecondary} /> : undefined
}

/** One person who can ask, with Remove. */
export function MobileBotMemberRow(props: {
  member: BotMember
  disabled: boolean
  onRemove: () => void
}) {
  const t = useMobileTranslation()
  return (
    <ListRow
      leading={memberMark(props.member)}
      title={props.member.name}
      accessory={
        <MobileBotTextButton
          label={t('bots.settings.remove', 'Remove')}
          accessibilityLabel={t('bots.settings.removeName', 'Remove {{name}}', {
            name: props.member.name
          })}
          disabled={props.disabled}
          onPress={props.onRemove}
        />
      }
    />
  )
}

/** The desktop's Who can ask summary and advice, from the same shared model, for the bot sheet. */
export function MobileBotWhoCanAsk(props: {
  bot: PhoneAccessBot & { members: readonly { id: string; name: string }[] }
  disabled: boolean
  onKeepOnlyMe: () => void
  onAskForApproval: () => void
  /** Each connector's people, under the summary. */
  children: ReactNode
}) {
  const { bot } = props
  const name = bot.name
  const place = botAccessPlace(bot.accessHost ?? { kind: 'unknown', name: null })
  const others = bot.members.map((member) => member.name || member.id)
  const permission = botStartingPermission(bot, null)
  const { who, control } = botAccessSummary(others)
  const advice = botAccessAdvice({
    others: others.length,
    permission,
    google: bot.google === true,
    canTurnOffGoogle: false
  })
  const fixDetail = (fix: Exclude<BotAccessFix, 'google-off'>): string =>
    fix === 'only-me'
      ? botAccessCopy('fixOnlyMeDetail')
      : botAccessCopy(bot.agent === 'codex' ? 'fixAskDetailCodex' : 'fixAskDetail', { name })
  const fixes = advice.fixes.filter(
    (fix): fix is Exclude<BotAccessFix, 'google-off'> => fix !== 'google-off'
  )
  return (
    <>
      <SettingsSection
        title={botAccessCopy('whoCanAsk', { name })}
        footer={botAccessCopy(control.id, { ...control.values, name, ...place })}
      >
        <ListRow title={botAccessCopy(who.id, { ...who.values, name })} wrapTitle />
      </SettingsSection>
      {props.children}
      {others.length > 0 ? (
        <SettingsSection title={botAccessCopy('reachHeading', { name })}>
          {phoneBotReachLines(bot).map((line) => (
            <ListRow key={line.title} title={line.title} wrapTitle subtitle={line.detail} />
          ))}
        </SettingsSection>
      ) : null}
      {fixes.length > 0 ? (
        <SettingsSection
          title={botAccessCopy('adviceHeading')}
          footer={botAccessCopy('separateBot', place)}
        >
          {fixes.map((fix) => (
            <ListRow
              key={fix}
              title={botAccessCopy(PHONE_FIXES[fix].headingId, { name })}
              wrapTitle
              subtitle={fixDetail(fix)}
              accessory={
                <MobileBotTextButton
                  label={botAccessCopy(PHONE_FIXES[fix].actionId)}
                  disabled={props.disabled}
                  onPress={fix === 'only-me' ? props.onKeepOnlyMe : props.onAskForApproval}
                />
              }
            />
          ))}
        </SettingsSection>
      ) : null}
    </>
  )
}

/** The phone has no Undo, so each fix asks first; giving access back would ask again too. */
export function MobileAccessFixConfirm(props: {
  fix: 'only-me' | 'ask-for-approval'
  bot: PhoneAccessBot & { members: readonly { id: string; name: string }[] }
  onCancel: () => void
  onConfirm: () => void
}) {
  const { bot } = props
  const name = bot.name
  return props.fix === 'only-me' ? (
    <ConfirmContent
      title={botAccessCopy('fixOnlyMeConfirm', { name })}
      message={botAccessCopy('fixOnlyMeConfirmDetail', {
        people: bot.members.map((member) => member.name || member.id).join(', '),
        name
      })}
      confirmLabel={botAccessCopy('fixOnlyMeAction')}
      destructive
      onCancel={props.onCancel}
      onConfirm={props.onConfirm}
    />
  ) : (
    <ConfirmContent
      title={botAccessCopy('fixAskConfirm')}
      message={botAccessCopy(bot.agent === 'codex' ? 'fixAskDetailCodex' : 'fixAskDetail', {
        name
      })}
      confirmLabel={botAccessCopy('fixAskAction')}
      onCancel={props.onCancel}
      onConfirm={props.onConfirm}
    />
  )
}
