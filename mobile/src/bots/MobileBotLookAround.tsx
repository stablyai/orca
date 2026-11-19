import { useState } from 'react'
import { Text, View } from 'react-native'
import {
  botLookAround,
  LOOK_AROUND_EVERY_CHOICES,
  LOOK_AROUND_EVERY_LABELS,
  LOOK_AROUND_FOCUS_MAX_LENGTH,
  type BotLookAround,
  type BotUpNext
} from '../../../src/shared/bots/bot-look-around'
import { ListRow } from '../components/list/ListGroup'
import { SheetHeader } from '../components/nav-bar/SheetHeader'
import { MobileStateButton } from '../components/feedback/MobileStateView'
import { TextField } from '../components/composer-input/TextField'
import {
  ChoiceRows,
  DrillRow,
  SwitchRow
} from '../host-screen/workspace-options/workspace-option-rows'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useBackClaim } from '../navigation/use-back-claim'
import { spacing } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import type { SheetBot } from './bot-sheet-operations'
import { lastLookedText } from './bot-up-next-copy'
import { MobileBotSettingsSection } from './MobileBotSettingsSection'
import { optionStyles } from './mobile-bot-option-styles'

export type LookAroundPage = 'every' | 'focus'

/** Saves only the changed field, so quick edits and the bot's own chat edits never undo each other. */
type SaveLookAround = (change: Partial<BotLookAround>) => void

/** The desktop's Look around settings, for a bot whose host runs looks. */
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
  return (
    <MobileBotSettingsSection
      title={t('bots.lookAround.title', 'Look around')}
      detail={t(
        'bots.lookAround.detail',
        'Reads connected apps and projects to suggest next steps. Read-only.',
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
              value={LOOK_AROUND_EVERY_LABELS[setting.every]}
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
              subtitle={lastLookedText(state?.lastLookedAt, props.upNext?.items.length ?? 0)}
              detail={
                <Text style={optionStyles.optionRowDetail}>
                  {t(
                    'bots.lookAround.requirements',
                    'Each look uses your agent plan. Orca must be running on the host.'
                  )}
                </Text>
              }
              accessory={
                <MobileStateButton
                  label={
                    state?.running
                      ? t('bots.lookAround.looking', 'Looking…')
                      : t('bots.lookAround.lookNow', 'Look now')
                  }
                  disabled={props.disabled || state?.running === true || props.bot.paused}
                  onPress={props.onLookNow}
                />
              }
            />
          ]
        : null}
    </MobileBotSettingsSection>
  )
}

function FocusField(props: {
  focus: string
  onChange: (focus: string) => void
  onDone: () => void
}) {
  const t = useMobileTranslation()
  return (
    <View style={pageStyles.focus}>
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
      <Text style={[optionStyles.optionRowDetail, pageStyles.hint]}>
        {t(
          'bots.lookAround.focusDetail',
          'Optional. Leave it empty and it looks for anything waiting on you.'
        )}
      </Text>
    </View>
  )
}

/** How often or Look for, drilled into from the section, like the workspace options' pages. */
export function MobileLookAroundPage(props: {
  page: LookAroundPage
  bot: SheetBot
  save: SaveLookAround
  onBack: () => void
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
        onBack={{ label: t('bots.lookAround.back', 'Back to Settings'), onPress: props.onBack }}
        {...(props.page === 'focus'
          ? { trailing: { label: t('bots.lookAround.save', 'Save'), onPress: saveFocus } }
          : {})}
      />
      {props.page === 'every' ? (
        <ChoiceRows
          choices={LOOK_AROUND_EVERY_CHOICES.map((id) => ({
            id,
            label: LOOK_AROUND_EVERY_LABELS[id]
          }))}
          selected={setting.every}
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

const pageStyles = themedStyleSheet(() => ({
  focus: {
    gap: spacing.sm,
    alignItems: 'stretch'
  },
  hint: {
    paddingHorizontal: spacing.xs
  }
}))
