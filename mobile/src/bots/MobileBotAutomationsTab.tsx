import { Text, View } from 'react-native'
import { CalendarClock, Plus } from 'lucide-react-native'
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
  saving: boolean
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
              disabled={props.saving}
            />
          ) : null}
          <MobileSwitch
            value={automation.enabled}
            onValueChange={props.onSetEnabled}
            disabled={props.saving}
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

/** The desktop's Automations panel: each automation in the bot's home, with Run Now and its switch. */
export function MobileBotAutomationsTab(props: {
  client: RpcClient | null
  bot: SheetBot
  rows: readonly BotAutomationRow<BotAutomationView>[] | null
  showToast: (message: string, durationMs?: number) => void
  onNewAutomation: (() => void) | null
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const { rows, saving, setAutomationEnabled, runNow } = useBotAutomations({
    client: props.client,
    rows: props.rows,
    showToast: props.showToast
  })
  if (!rows) {
    return <MobileStateView loading title={t('bots.activity.loading', 'Loading activity…')} />
  }
  return (
    <>
      <SectionHeader title={t('bots.sheet.automations', 'Automations')} />
      {rows.length > 0 ? (
        <ListGroup>
          {rows.map((row) => (
            <AutomationRow
              key={row.key}
              row={row}
              bot={props.bot}
              saving={saving.has(row.automation.id)}
              onSetEnabled={(next) => void setAutomationEnabled(row.automation.id, next)}
              onRunNow={() => void runNow(row.automation.id)}
            />
          ))}
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

const styles = themedStyleSheet(() => ({
  newAutomation: { marginTop: spacing.sm }
}))
