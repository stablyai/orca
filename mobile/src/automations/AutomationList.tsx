import { automationOrphanIssueText } from './automation-orphan-issue-copy'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { translate } from '../i18n/mobile-i18n'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { CalendarClock } from 'lucide-react-native'
import { MobileSwitch } from '../components/controls/MobileSwitch'
import { MobileStateView } from '../components/feedback/MobileStateView'
import { MobileAgentIcon } from '../components/icons/MobileAgentIcon'
import { ListGroup, ListRow } from '../components/list/ListGroup'
import { colors } from '../theme/mobile-theme'
import { automationScheduleText } from './automation-schedule-label'
import type { MobileAutomationRow } from './automation-reply-schema'

export function AutomationList(props: {
  rows: MobileAutomationRow[]
  loaded: boolean
  disabled: boolean
  projectName: (automation: MobileAutomationRow['automation']) => string | undefined
  onCreate: () => void
  onOpen: (row: MobileAutomationRow) => void
  onToggle: (row: MobileAutomationRow, enabled: boolean) => void
}) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  if (!props.loaded) {
    return (
      <MobileStateView
        loading
        title={t('automations.mobile.loadingAutomations', 'Loading automations…')}
      />
    )
  }
  if (props.rows.length === 0) {
    return (
      <MobileStateView
        icon={CalendarClock}
        title={automationsEmptyTitle()}
        message={automationsEmptyMessage()}
        action={
          props.disabled
            ? null
            : {
                label: t('automations.mobile.newAutomation', 'New automation'),
                onPress: props.onCreate
              }
        }
      />
    )
  }
  return (
    <ListGroup>
      {props.rows.map((row) => {
        const { automation } = row
        const { subtitle, orphan } = automationRowSubtitle(row, props.projectName(automation))
        return (
          <ListRow
            key={automation.id}
            title={automation.name}
            subtitle={subtitle}
            subtitleLines={1}
            subtitleColor={orphan ? colors.statusRed : undefined}
            subtitleIcon={
              orphan ? undefined : <MobileAgentIcon agentId={automation.agentId} size={12} />
            }
            accessibilityLabel={`${automation.name}, ${subtitle}`}
            onPress={() => props.onOpen(row)}
            accessory={
              <MobileSwitch
                accessibilityLabel={t(
                  'automations.mobile.runOnSchedule',
                  'Run {{name}} on schedule',
                  { name: automation.name }
                )}
                value={automation.enabled}
                onValueChange={(enabled) => props.onToggle(row, enabled)}
                disabled={props.disabled}
              />
            }
          />
        )
      })}
    </ListGroup>
  )
}

/** A row's one line: its schedule and project, or what broke its owner. Shared with Home's tab. */
export function automationRowSubtitle(
  row: MobileAutomationRow,
  project: string | undefined
): { subtitle: string; orphan: boolean } {
  const { automation, item } = row
  return item.selector.kind === 'orphan'
    ? { subtitle: automationOrphanIssueText(item.selector.issue), orphan: true }
    : {
        subtitle: [automationScheduleText(automation), project].filter(Boolean).join(' · '),
        orphan: false
      }
}

export const automationsEmptyTitle = () =>
  translate('automations.mobile.noAutomations', 'No automations yet')
export const automationsEmptyMessage = () =>
  translate('automations.mobile.noAutomationsHint', 'Schedule an agent to work on this computer.')
