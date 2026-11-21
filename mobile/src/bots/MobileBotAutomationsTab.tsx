import { Text } from 'react-native'
import {
  CalendarClock,
  Clock,
  History,
  MessageSquare,
  Pencil,
  Play,
  Plus,
  Trash2,
  Zap
} from '../components/icons/app-icons'
import { hasAutomationSchedule } from '../../../src/shared/automation-event-triggers'
import { useNow } from '../hooks/use-now'
import { getUiIntlLocale } from '../i18n/ui-intl-locale'
import { botWaitTimeFormat } from '../../../src/shared/bots/bot-row-line'
import { MobileBotTextButton } from './MobileBotTextButton'
import { MobileStateView } from '../components/feedback/MobileStateView'
import { MobileSwitch } from '../components/controls/MobileSwitch'
import { DrawnMenu } from '../components/menu/DrawnMenu'
import type { ActionSheetAction } from '../components/sheets/ActionSheetModal'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { LIST_LEADING_INSET, ListGroup, ListRow, SectionHeader } from '../components/list/ListGroup'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import type { BotAutomationRow } from '../../../src/shared/bots/bot-automation-rows'
import type { BotAutomationView } from '../../../src/shared/bots/bot-activity-schema'
import type { SheetBot } from './bot-sheet-operations'
import { automationWhenText, automationWontFireNote } from './mobile-bot-sheet-copy'
import { sheetStyles } from './mobile-bot-sheet-styles'
import { useBotAutomations } from './use-bot-automations'
import { optionStyles } from './mobile-bot-option-styles'
import { colors, spacing } from '../theme/mobile-theme'
import type { PresentAutomationSheet } from '../automations/AutomationSheets'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'

/** What an automation's ⋯ menu can do besides Run now and Delete; each is absent where it can't. */
export type BotAutomationRowActions = {
  onEdit: ((automationId: string) => void) | null
  /** Drafts a message in the agent's chat, where its events are changed. */
  onAskInChat: ((draft: string) => void) | null
  onViewRuns: ((automationId: string) => void) | null
  /** Opens a confirm beside the drawer; null where none can open, which leaves out Delete. */
  present: PresentAutomationSheet | null
}

function AutomationRow(props: {
  row: BotAutomationRow<BotAutomationView>
  bot: SheetBot
  disabled: boolean
  actions: BotAutomationRowActions
  onSetEnabled: (next: boolean) => void
  onRunNow: () => void
  onDelete: (() => void) | null
}) {
  const t = useMobileTranslation()
  const { automation, failing } = props.row
  const { onEdit, onAskInChat, onViewRuns } = props.actions
  const wontFire = automationWontFireNote(automation, props.bot)
  const Kind = hasAutomationSchedule(automation) ? Clock : Zap
  const menu: ActionSheetAction[][] = [
    [
      {
        label: t('bots.automations.runNow', 'Run now'),
        icon: Play,
        disabled: props.disabled,
        onPress: props.onRunNow
      },
      ...(onEdit
        ? [
            {
              label: t('common.edit', 'Edit'),
              icon: Pencil,
              closeBeforePress: true,
              onPress: () => onEdit(automation.id)
            }
          ]
        : []),
      ...(onAskInChat
        ? [
            {
              label: t('automations.botEvents.editInChat', 'Edit in chat'),
              icon: MessageSquare,
              closeBeforePress: true,
              onPress: () =>
                onAskInChat(
                  t('automations.botEvents.editDraft', 'Change the automation “{{name}}”: ', {
                    name: automation.name
                  })
                )
            }
          ]
        : []),
      ...(onViewRuns
        ? [
            {
              label: t('bots.automations.viewRuns', 'View runs'),
              icon: History,
              closeBeforePress: true,
              onPress: () => onViewRuns(automation.id)
            }
          ]
        : [])
    ],
    props.onDelete
      ? [
          {
            label: t('automations.mobile.deleteAutomation', 'Delete automation'),
            icon: Trash2,
            destructive: true,
            disabled: props.disabled,
            closeBeforePress: true,
            onPress: props.onDelete
          }
        ]
      : []
  ]
  // Drawn: the whole row opens it, and a native menu would also swallow taps on the row's switch.
  return (
    <DrawnMenu groups={menu}>
      {(openMenu) => (
        <ListRow
          title={automation.name}
          subtitle={automationWhenText(automation, automation.enabled)}
          leading={<Kind size={18} color={colors.textSecondary} strokeWidth={1.8} />}
          onPress={openMenu}
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
          }
        />
      )}
    </DrawnMenu>
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

/** The desktop's Automations panel: each automation in the bot's home with its switch, a tap opening
 *  its menu (Run now, Edit, Edit in chat, View runs, Delete), then its waits, with Cancel. */
export function MobileBotAutomationsTab(props: {
  client: RpcClient | null
  bot: SheetBot
  rows: readonly BotAutomationRow<BotAutomationView>[] | null
  /** One-shot "wait for X, then do Y" automations the bot made. */
  waits?: readonly BotAutomationRow<BotAutomationView>[]
  showToast: (message: string, durationMs?: number) => void
  onNewAutomation: (() => void) | null
  actions: BotAutomationRowActions
  /** The host answers: off, the switches and Run now are too. */
  online: boolean
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const { present } = props.actions
  const now = useNow(60_000)
  const { rows, waits, saving, setAutomationEnabled, runNow, remove } = useBotAutomations({
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
        <ListGroup separatorInset={LIST_LEADING_INSET}>
          {[
            ...rows.map((row) => (
              <AutomationRow
                key={row.key}
                row={row}
                bot={props.bot}
                disabled={!props.online || saving.has(row.automation.id)}
                actions={props.actions}
                onSetEnabled={(next) => void setAutomationEnabled(row.automation.id, next)}
                onRunNow={() => void runNow(row.automation.id)}
                onDelete={
                  present
                    ? () =>
                        present({
                          kind: 'confirm',
                          title: t('common.delete', 'Delete'),
                          message: t(
                            'automations.mobile.deleteRetained',
                            'Delete “{{name}}” and its retained runs?',
                            { name: row.automation.name }
                          ),
                          confirmLabel: t('common.delete', 'Delete'),
                          destructive: true,
                          onConfirm: () => void remove(row.automation.id)
                        })
                    : null
                }
              />
            )),
            ...waits.map((row) => (
              <WaitRow
                key={`wait:${row.key}`}
                row={row}
                now={now}
                disabled={!props.online || saving.has(row.automation.id)}
                onCancel={() => void remove(row.automation.id)}
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
