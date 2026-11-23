import { useState, type ReactNode } from 'react'
import {
  botLookAround,
  LOOK_AROUND_EVERY_CHOICES,
  LOOK_AROUND_FOCUS_MAX_LENGTH,
  type BotLookAround,
  type BotUpNext
} from '../../../src/shared/bots/bot-look-around'
import { lookAroundEveryLabel } from '../../../src/shared/bots/bot-look-around-every-label'
import { ListRow } from '../components/list/ListGroup'
import { SheetHeader } from '../components/nav-bar/SheetHeader'
import { TextField } from '../components/composer-input/TextField'
import {
  ChoiceRows,
  DrillRow,
  SwitchRow
} from '../host-screen/workspace-options/workspace-option-rows'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useBackClaim } from '../navigation/use-back-claim'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import type { SheetBot } from './bot-sheet-operations'
import { lookedWhen } from './bot-up-next-copy'
import { SettingsNote, SettingsSection } from '../settings/settings-screen-frame'

export type LookAroundPage = 'every' | 'focus'

/** Saves only the changed field, so quick edits and the bot's own chat edits never undo each other. */
type SaveLookAround = (change: Partial<BotLookAround>) => void

/** The desktop's Look around page, for a bot whose host runs looks. */
export function MobileLookAroundSection(props: {
  bot: SheetBot
  upNext: BotUpNext | undefined
  disabled: boolean
  save: SaveLookAround
  onOpen: (page: LookAroundPage) => void
  onLookNow: () => void
}) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  const setting = botLookAround(props.bot)
  const state = props.upNext?.state
  const lastLookedAt = state?.lastLookedAt
  return (
    <SettingsSection
      first
      footer={t(
        'bots.lookAround.detail',
        'Reads connected apps and projects to suggest next steps. Read-only. Each look uses your agent plan, and Orca must be running on the host.',
        { name: props.bot.name }
      )}
    >
      <SwitchRow
        label={t('bots.lookAround.on', 'Suggest next steps')}
        value={setting.on}
        disabled={props.disabled}
        onChange={(on) => props.save({ on })}
      />
      {setting.on
        ? [
            <DrillRow
              key="every"
              label={t('bots.lookAround.every', 'How often')}
              value={lookAroundEveryLabel(setting.every, t)}
              detail
              disabled={props.disabled}
              onPress={() => props.onOpen('every')}
            />,
            <SwitchRow
              key="weekdays"
              label={t('bots.lookAround.weekdaysOnly', 'Weekdays only')}
              value={setting.weekdaysOnly}
              disabled={props.disabled}
              onChange={(weekdaysOnly) => props.save({ weekdaysOnly })}
            />,
            <DrillRow
              key="focus"
              label={t('bots.lookAround.focus', 'Look for')}
              value={setting.focus || t('bots.lookAround.anything', 'Anything waiting on you')}
              detail
              disabled={props.disabled}
              onPress={() => props.onOpen('focus')}
            />,
            <ListRow
              key="last-looked"
              title={t('bots.lookAround.lastLooked', 'Last looked')}
              value={
                lastLookedAt === undefined
                  ? t('bots.lookAround.notYet', 'Not yet')
                  : lookedWhen(lastLookedAt)
              }
            />,
            <ListRow
              key="now"
              title={
                state?.running
                  ? t('bots.lookAround.looking', 'Looking…')
                  : t('bots.lookAround.lookNow', 'Look now')
              }
              disabled={props.disabled || state?.running === true || props.bot.paused}
              onPress={props.onLookNow}
              accessibilityRole="button"
            />
          ]
        : null}
    </SettingsSection>
  )
}

function FocusField(props: {
  focus: string
  onChange: (focus: string) => void
  onDone: () => void
}) {
  const t = useMobileTranslation()
  return (
    <>
      <TextField
        value={props.focus}
        onChangeText={props.onChange}
        maxLength={LOOK_AROUND_FOCUS_MAX_LENGTH}
        placeholder={t(
          'bots.lookAround.focusPlaceholder',
          'PRs waiting on me, questions in #eng, issues due this week'
        )}
        autoFocus
        returnKeyType="done"
        onSubmitEditing={props.onDone}
      />
      <SettingsNote>
        {t(
          'bots.lookAround.focusDetail',
          'Optional. Leave it empty and it looks for anything waiting on you.'
        )}
      </SettingsNote>
    </>
  )
}

/** How often or Look for, drilled into from Look around, like the workspace options' pages. */
export function MobileLookAroundPage(props: {
  page: LookAroundPage
  bot: SheetBot
  save: SaveLookAround
  onBack: () => void
  /** Offline: the choices and Save are off, and the typed text stays. */
  disabled: boolean
  banner: ReactNode
}) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  useBackClaim(() => {
    props.onBack()
    return true
  })
  const setting = botLookAround(props.bot)
  // Compared with the value as the page opened, so an untouched field never undoes a newer edit.
  const [initialFocus] = useState(setting.focus)
  const [focus, setFocus] = useState(initialFocus)
  const saveFocus = () => {
    if (props.disabled) {
      return
    }
    const typed = focus.trim()
    if (typed !== initialFocus) {
      props.save({ focus: typed })
    }
    props.onBack()
  }
  const title =
    props.page === 'every'
      ? t('bots.lookAround.every', 'How often')
      : t('bots.lookAround.focus', 'Look for')
  return (
    <>
      <SheetHeader
        title={title}
        onBack={{
          label: t('bots.lookAround.backToLookAround', 'Back to Look around'),
          onPress: props.onBack
        }}
        {...(props.page === 'focus'
          ? {
              trailing: {
                label: t('bots.lookAround.save', 'Save'),
                onPress: saveFocus,
                disabled: props.disabled
              }
            }
          : {})}
      />
      {props.banner}
      {props.page === 'every' ? (
        <ChoiceRows
          choices={LOOK_AROUND_EVERY_CHOICES.map((id) => ({
            id,
            label: lookAroundEveryLabel(id, t)
          }))}
          selected={setting.every}
          disabled={props.disabled}
          onSelect={(every) => {
            props.save({ every })
            props.onBack()
          }}
        />
      ) : (
        <FocusField focus={focus} onChange={setFocus} onDone={saveFocus} />
      )}
    </>
  )
}
