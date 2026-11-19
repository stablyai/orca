import type { ReactNode } from 'react'
import { Text, View } from 'react-native'
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
import { ConfirmContent } from '../components/sheets/ConfirmModal'
import { ListGroup, ListRow, SectionHeader } from '../components/list/ListGroup'
import { MobileBotTextButton } from './MobileBotTextButton'
import { phoneBotReachLines, type PhoneAccessBot } from './bot-access-request-copy'
import { optionStyles } from './mobile-bot-option-styles'

// The phone can't read the app's chat permission, nor turn Google off: those stay on the desktop.
const PHONE_FIXES: Record<
  Exclude<BotAccessFix, 'google-off'>,
  { headingId: BotAccessCopyId; actionId: BotAccessCopyId }
> = {
  'only-me': { headingId: 'fixOnlyMe', actionId: 'fixOnlyMeAction' },
  'ask-for-approval': { headingId: 'fixAsk', actionId: 'fixAskAction' }
}

/** The desktop's Who can ask summary and advice, from the same shared model, for the bot sheet. */
export function MobileBotWhoCanAsk(props: {
  bot: PhoneAccessBot & { members: readonly { id: string; name: string }[] }
  disabled: boolean
  onKeepOnlyMe: () => void
  onAskForApproval: () => void
  /** The people rows, after the summary. */
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
    <View>
      <SectionHeader title={botAccessCopy('whoCanAsk', { name })} />
      <View style={optionStyles.optionPageTitle}>
        <Text style={optionStyles.summaryTitle}>
          {botAccessCopy(who.id, { ...who.values, name })}
        </Text>
        <Text style={optionStyles.optionRowDetail}>
          {botAccessCopy(control.id, { ...control.values, name, ...place })}
        </Text>
      </View>
      {bot.members.length > 0 ? <ListGroup>{props.children}</ListGroup> : null}
      {others.length > 0 ? (
        <>
          <SectionHeader title={botAccessCopy('reachHeading', { name })} />
          <ListGroup>
            {phoneBotReachLines(bot).map((line) => (
              <ListRow key={line.title} title={line.title} wrapTitle subtitle={line.detail} />
            ))}
          </ListGroup>
        </>
      ) : null}
      {fixes.length > 0 ? (
        <>
          <SectionHeader title={botAccessCopy('adviceHeading')} />
          <ListGroup>
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
          </ListGroup>
          <Text style={[optionStyles.optionRowDetail, optionStyles.optionPageTitle]}>
            {botAccessCopy('separateBot', place)}
          </Text>
        </>
      ) : null}
    </View>
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
