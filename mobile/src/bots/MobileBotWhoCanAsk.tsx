import type { BotAccessCopyId } from '../../../src/shared/bots/bot-access-copy'
import { botAccessAdvice, botStartingPermission } from '../../../src/shared/bots/bot-access-reach'
import { ConfirmContent } from '../components/sheets/ConfirmModal'
import { intlLocaleFor } from '../i18n/ui-intl-locale'
import { useMobileTranslation, useMobileUiLocale } from '../i18n/use-mobile-translation'
import { ListRow } from '../components/list/ListGroup'
import { SettingsNote, SettingsSection } from '../settings/settings-screen-frame'
import type { PhoneAccessBot } from './bot-access-request-copy'
import {
  mobileBotAccessCopy,
  mobileBotAccessNames,
  mobileBotAccessPlace
} from './mobile-bot-access-copy'

/** The end of Who can ask: Keep only me (and Ask for approval when advised), then what they reach,
 *  in one line. The phone can't turn Google off, so that fix stays on the desktop. */
export function MobileBotWhoCanAskEnd(props: {
  bot: PhoneAccessBot & { members: readonly { id: string; name: string }[] }
  disabled: boolean
  onKeepOnlyMe: () => void
  onAskForApproval: () => void
}) {
  const t = useMobileTranslation()
  const { bot } = props
  const { computer } = mobileBotAccessPlace(t, bot.accessHost ?? { kind: 'unknown', name: null })
  const others = bot.members.length
  const askFirst = botAccessAdvice({
    others,
    permission: botStartingPermission(bot, null),
    google: bot.google === true,
    canTurnOffGoogle: false
  }).fixes.includes('ask-for-approval')
  const reach: BotAccessCopyId = others > 0 ? 'controlBriefOnHost' : 'controlBriefIfAddedOnHost'
  const footer = mobileBotAccessCopy(t, reach, { computer })
  if (others === 0) {
    return <SettingsNote>{footer}</SettingsNote>
  }
  return (
    <SettingsSection footer={footer}>
      {askFirst ? (
        <ListRow
          title={mobileBotAccessCopy(t, 'fixAsk')}
          wrapTitle
          disabled={props.disabled}
          onPress={props.onAskForApproval}
        />
      ) : null}
      <ListRow
        title={mobileBotAccessCopy(t, 'fixOnlyMeAction')}
        destructive
        disabled={props.disabled}
        onPress={props.onKeepOnlyMe}
      />
    </SettingsSection>
  )
}

/** The phone has no Undo, so each fix asks first; giving access back would ask again too. */
export function MobileAccessFixConfirm(props: {
  fix: 'only-me' | 'ask-for-approval'
  bot: PhoneAccessBot & { members: readonly { id: string; name: string }[] }
  onCancel: () => void
  onConfirm: () => void
}) {
  const t = useMobileTranslation()
  const intlLocale = intlLocaleFor(useMobileUiLocale())
  const { bot } = props
  const name = bot.name
  return props.fix === 'only-me' ? (
    <ConfirmContent
      title={mobileBotAccessCopy(t, 'fixOnlyMeConfirm', { name })}
      message={mobileBotAccessCopy(t, 'fixOnlyMeConfirmDetail', {
        people: mobileBotAccessNames(
          bot.members.map((member) => member.name || member.id),
          intlLocale
        ),
        name
      })}
      confirmLabel={mobileBotAccessCopy(t, 'fixOnlyMeAction')}
      destructive
      onCancel={props.onCancel}
      onConfirm={props.onConfirm}
    />
  ) : (
    <ConfirmContent
      title={mobileBotAccessCopy(t, 'fixAskConfirm')}
      message={mobileBotAccessCopy(
        t,
        bot.agent === 'codex' ? 'fixAskDetailCodex' : 'fixAskDetail',
        {
          name
        }
      )}
      confirmLabel={mobileBotAccessCopy(t, 'fixAskAction')}
      onCancel={props.onCancel}
      onConfirm={props.onConfirm}
    />
  )
}
