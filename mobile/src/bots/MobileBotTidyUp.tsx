// The desktop's Memory upkeep on the phone: Tidy-up's switch, How often, Tidy now, and the last
// run's changes with Undo, which reverts the whole run (its one History row).
import { Text } from 'react-native'
import {
  botTidyUp,
  TIDY_UP_EVERY_CHOICES,
  tidyUpChangeCount,
  type BotTidyUp,
  type BotTidyUpView,
  type TidyUpEvery
} from '../../../src/shared/bots/bot-tidy-up'
import { ListGroup, ListRow, SectionHeader } from '../components/list/ListGroup'
import { SheetHeader } from '../components/nav-bar/SheetHeader'
import {
  ChoiceRows,
  DrillRow,
  SwitchRow
} from '../host-screen/workspace-options/workspace-option-rows'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useBackClaim } from '../navigation/use-back-claim'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { lookedWhen } from './bot-up-next-copy'
import type { SheetBot } from './bot-sheet-operations'
import { optionStyles } from './mobile-bot-option-styles'
import { MobileBotSettingsSection } from './MobileBotSettingsSection'
import { MobileBotTextButton } from './MobileBotTextButton'

export type TidyUpPage = 'every' | 'summary'
type Run = NonNullable<BotTidyUpView['last']>

function everyLabel(t: ReturnType<typeof useMobileTranslation>, every: TidyUpEvery): string {
  return every === 'night'
    ? t('bots.tidyUp.everyNight', 'Each night')
    : t('bots.tidyUp.everyWeek', 'Once a week')
}

export function MobileTidyUpSection(props: {
  bot: SheetBot
  view: BotTidyUpView | null
  disabled: boolean
  save: (change: Partial<BotTidyUp>) => void
  onOpen: (page: TidyUpPage) => void
  onTidyNow: () => void
}) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  const setting = botTidyUp(props.bot)
  const last = props.view?.last ?? null
  return (
    <MobileBotSettingsSection title={t('bots.tidyUp.title', 'Memory upkeep')}>
      <SwitchRow
        label={t('bots.tidyUp.on', 'Tidy memory overnight')}
        detail={
          props.view?.turnedOff
            ? t('bots.tidyUp.turnedOff', 'Turned off after 10 tidy-ups in a row failed.')
            : undefined
        }
        value={setting.on}
        disabled={props.disabled}
        onChange={(on) => props.save({ on })}
      />
      {setting.on
        ? [
            <DrillRow
              key="every"
              label={t('bots.tidyUp.every', 'How often')}
              value={everyLabel(t, setting.every)}
              disabled={props.disabled}
              onPress={() => props.onOpen('every')}
            />,
            <ListRow
              key="last"
              title={t('bots.tidyUp.lastTidied', 'Last tidied')}
              subtitle={
                last
                  ? `${lookedWhen(last.at)} · ${t('bots.tidyUp.changes', '{{count}} changes', { count: tidyUpChangeCount(last) })}`
                  : t('bots.tidyUp.never', 'Not yet')
              }
              navigates={last !== null}
              disabled={last === null}
              onPress={() => props.onOpen('summary')}
            />,
            <ListRow
              key="now"
              title={
                props.view?.running
                  ? t('bots.tidyUp.tidying', 'Tidying…')
                  : t('bots.tidyUp.now', 'Tidy now')
              }
              disabled={props.disabled || props.view?.running === true || props.bot.paused}
              onPress={props.onTidyNow}
              accessibilityRole="button"
            />
          ]
        : null}
      <Text style={[optionStyles.optionRowDetail, optionStyles.optionPageTitle]}>
        {t(
          'bots.tidyUp.footer',
          'Changes memory files only. Uses your agent plan, like a short chat. Orca must be running on your computer.'
        )}
      </Text>
    </MobileBotSettingsSection>
  )
}

function SummaryGroup(props: { title: string; lines: string[] }) {
  if (props.lines.length === 0) {
    return null
  }
  return (
    <>
      <SectionHeader title={props.title} />
      <ListGroup>
        {props.lines.map((line) => (
          <ListRow key={line} title={line} wrapTitle />
        ))}
      </ListGroup>
    </>
  )
}

function Summary(props: { run: Run; busy: boolean; onUndo: (rowId: string) => void }) {
  const t = useMobileTranslation()
  const { run } = props
  const minutes = Math.max(1, Math.round(run.tookMs / 60_000))
  const tidied = [
    ...(run.merged > 0
      ? [t('bots.tidyUp.merged', 'Merged {{count}} repeated lines', { count: run.merged })]
      : []),
    ...run.replaced.map((fact) => t('bots.tidyUp.replaced', 'Marked replaced: {{fact}}', { fact })),
    ...run.filed.map(({ topic, count }) =>
      t('bots.tidyUp.filed', 'Filed {{count}} lines into memory/{{topic}}.md', { count, topic })
    ),
    ...(run.moved > 0
      ? [t('bots.tidyUp.moved', 'Moved {{count}} old lines to the archive', { count: run.moved })]
      : [])
  ]
  return (
    <>
      <Text style={[optionStyles.optionRowDetail, optionStyles.optionPageTitle]}>
        {[
          lookedWhen(run.at),
          t('bots.tidyUp.readChats', 'read {{count}} chats', { count: run.chats }),
          t('bots.tidyUp.took', 'took {{value}} min', { value: minutes })
        ].join(' · ')}
      </Text>
      <SummaryGroup title={t('bots.tidyUp.learned', 'Learned from chats')} lines={run.learned} />
      <SummaryGroup title={t('bots.tidyUp.tidied', 'Tidied')} lines={tidied} />
      <ListGroup>
        <ListRow
          title={
            run.undone
              ? t('bots.tidyUp.undone', 'Undone')
              : t('bots.tidyUp.undoAll', 'Undo this tidy-up')
          }
          disabled={run.undone || run.rowId === null || props.busy}
          accessory={
            run.undone ? undefined : (
              <MobileBotTextButton
                label={t('bots.tidyUp.undo', 'Undo')}
                disabled={run.rowId === null || props.busy}
                onPress={() => run.rowId && props.onUndo(run.rowId)}
              />
            )
          }
        />
      </ListGroup>
      <Text style={[optionStyles.optionRowDetail, optionStyles.optionPageTitle]}>
        {t(
          'bots.tidyUp.undoNote',
          'Undo puts MEMORY.md back as it was before this tidy-up, all at once. Full history and memory editing are on your computer, in Settings → Memory.'
        )}
      </Text>
    </>
  )
}

/** How often, or the last run's changes, drilled into from the section. */
export function MobileTidyUpPage(props: {
  page: TidyUpPage
  bot: SheetBot
  view: BotTidyUpView | null
  busy: boolean
  save: (change: Partial<BotTidyUp>) => void
  onUndo: (rowId: string) => void
  onBack: () => void
}) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  useBackClaim(() => {
    props.onBack()
    return true
  })
  const run = props.view?.last ?? null
  return (
    <>
      <SheetHeader
        title={
          props.page === 'every'
            ? t('bots.tidyUp.every', 'How often')
            : t('bots.tidyUp.summaryTitle', 'Last tidy-up')
        }
        onBack={{ label: t('bots.lookAround.back', 'Back to Settings'), onPress: props.onBack }}
      />
      {props.page === 'every' ? (
        <ChoiceRows
          choices={TIDY_UP_EVERY_CHOICES.map((id) => ({ id, label: everyLabel(t, id) }))}
          selected={botTidyUp(props.bot).every}
          onSelect={(every) => {
            props.save({ every })
            props.onBack()
          }}
        />
      ) : run ? (
        <Summary run={run} busy={props.busy} onUndo={props.onUndo} />
      ) : null}
    </>
  )
}
