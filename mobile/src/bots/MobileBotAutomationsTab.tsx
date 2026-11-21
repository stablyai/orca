import { Text, View } from 'react-native'
import { CalendarClock, Plus } from 'lucide-react-native'
import { useNow } from '../hooks/use-now'
import { getUiIntlLocale } from '../i18n/ui-intl-locale'
import { botWaitTimeFormat } from '../../../src/shared/bots/bot-row-line'
import { MobileStateView } from '../components/feedback/MobileStateView'
import { MobileSwitch } from '../components/controls/MobileSwitch'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { ListGroup, ListRow, SectionHeader } from '../components/list/ListGroup'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import type { BotAutomationRow } from '../../../src/shared/bots/bot-automation-rows'
import type { BotAutomationView } from '../../../src/shared/bots/bot-activity-schema'
import type { SheetBot } from './bot-sheet-operations'
import { automationWhenText, automationWontFireNote } from './mobile-bot-sheet-copy'
import { sheetStyles } from './mobile-bot-sheet-styles'
import { MobileBotTextButton } from './MobileBotTextButton'
import { useBotAutomations } from './use-bot-automations'
import { optionStyles } from './mobile-bot-option-styles'
import { colors, spacing } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'

function AutomationRow(props: {
  row: BotAutomationRow<BotAutomationView>
  bot: SheetBot
  disabled: boolean
  onSetEnabled: (next: boolean) => void
  onRunNow: () => void
}) {
  const t = useMobileTranslation()
  const { automation, failing } = props.row
  const wontFire = automationWontFireNote(automation, props.bot)
  return (
    <ListRow
      title={automation.name}
      subtitle={automationWhenText(automation, automation.enabled)}
      detail={
        <>
          {wontFire ? <Text style={optionStyles.optionRowDetail}>{wontFire}</Text> : null}
          {failing ? (
            <Text style={sheetStyles.alert}>
              {t('bots.automations.couldNotFinish', 'Couldn’t finish')}
            </Text>
          ) : null}
        </>
      }
      accessory={
        <View style={optionStyles.rowActions}>
          {automation.enabled ? (
            <MobileBotTextButton
              label={t('bots.automations.runNow', 'Run now')}
              onPress={props.onRunNow}
              disabled={props.disabled}
            />
          ) : null}
          <MobileSwitch
            value={automation.enabled}
            onValueChange={props.onSetEnabled}
            disabled={props.disabled}
            accessibilityLabel={
              automation.enabled
                ? t('bots.automations.pause', 'Pause {{name}}', { name: automation.name })
                : t('bots.automations.resume', 'Resume {{name}}', { name: automation.name })
            }
          />
        </View>
      }
    />
  )
}

/** A wait the bot set itself; Cancel deletes it without running it, and doesn't ask first (as on the
 *  desktop). */
function WaitRow(props: {
  row: BotAutomationRow<BotAutomationView>
  now: number
  disabled: boolean
  onCancel: () => void
}) {
  const t = useMobileTranslation()
  const { automation } = props.row
  const by = automation.once?.by
  return (
    <ListRow
      title={automation.name}
      subtitle={
        by === undefined
          ? t('bots.waits.noDeadline', 'No deadline')
          : t('bots.waits.until', 'Until {{time}}', {
              time: new Intl.DateTimeFormat(
                getUiIntlLocale(),
                botWaitTimeFormat(by, props.now)
              ).format(by)
            })
      }
      accessory={
        <MobileBotTextButton
          label={t('bots.waits.cancel', 'Cancel')}
          accessibilityLabel={t('bots.waits.cancelNamed', 'Cancel waiting for {{name}}', {
            name: automation.name
          })}
          onPress={props.onCancel}
          disabled={props.disabled}
        />
      }
    />
  )
}

/** The desktop's Automations panel: each automation in the bot's home, with Run Now and its switch,
 *  then its waits, with Cancel. */
export function MobileBotAutomationsTab(props: {
  client: RpcClient | null
  bot: SheetBot
  rows: readonly BotAutomationRow<BotAutomationView>[] | null
  /** One-shot "wait for X, then do Y" automations the bot made. */
  waits?: readonly BotAutomationRow<BotAutomationView>[]
  showToast: (message: string, durationMs?: number) => void
  onNewAutomation: (() => void) | null
  /** The host answers: off, the switches and Run now are too. */
  online: boolean
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const now = useNow(60_000)
  const { rows, waits, saving, setAutomationEnabled, runNow, cancelWait } = useBotAutomations({
    client: props.client,
    rows: props.rows,
    waits: props.waits ?? NO_WAITS,
    showToast: props.showToast
  })
  if (!rows) {
    return <MobileStateView loading title={t('bots.activity.loading', 'Loading activity…')} />
  }
  return (
    <>
      <SectionHeader title={t('bots.sheet.automations', 'Automations')} />
      {rows.length + waits.length > 0 ? (
        <ListGroup>
          {[
            ...rows.map((row) => (
              <AutomationRow
                key={row.key}
                row={row}
                bot={props.bot}
                disabled={!props.online || saving.has(row.automation.id)}
                onSetEnabled={(next) => void setAutomationEnabled(row.automation.id, next)}
                onRunNow={() => void runNow(row.automation.id)}
              />
            )),
            ...waits.map((row) => (
              <WaitRow
                key={`wait:${row.key}`}
                row={row}
                now={now}
                disabled={!props.online || saving.has(row.automation.id)}
                onCancel={() => void cancelWait(row.automation.id)}
              />
            ))
          ]}
        </ListGroup>
      ) : (
        <MobileStateView
          icon={CalendarClock}
          title={t('bots.automations.emptyTitle', 'No automations yet')}
          message={t('bots.automations.empty', 'Ask in chat to set up an automation.')}
        />
      )}
      {props.onNewAutomation ? (
        <ListGroup style={styles.newAutomation}>
          <ListRow
            title={t('bots.automations.newAutomation', 'New automation')}
            leading={<Plus size={18} color={colors.textMuted} />}
            onPress={props.onNewAutomation}
          />
        </ListGroup>
      ) : null}
    </>
  )
}

const NO_WAITS: readonly BotAutomationRow<BotAutomationView>[] = []

const styles = themedStyleSheet(() => ({
  newAutomation: { marginTop: spacing.sm }
}))
