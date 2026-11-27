// The editor's Advanced page: time zone, catch-up, the workspace's setup and the precheck.
import { View } from 'react-native'
import { MobileSwitch } from '../components/controls/MobileSwitch'
import { ListGroup, ListRow, SectionHeader } from '../components/list/ListGroup'
import type { PickerOption } from '../components/sheets/PickerModal'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { spacing } from '../theme/mobile-theme'
import { themedStyleSheet, useThemedStyles } from '../theme/themed-styles'
import type { AutomationDraft } from './automation-draft'
import type { PresentAutomationSheet } from './AutomationSheets'
import { PickerRow } from './BotAutomationWhenRows'

const GRACE_MINUTES = [0, 30, 60, 180, 720, 1440, 2880]
const TIMEOUT_SECONDS = [30, 60, 120, 300, 600]

/** Time zone, catch-up, the workspace's setup and the precheck, as the editor's Advanced page. */
export function AutomationAdvancedRows({
  draft,
  change,
  present,
  disabled,
  extraArgs
}: {
  draft: AutomationDraft
  change: (patch: Partial<AutomationDraft>) => void
  present: PresentAutomationSheet
  disabled: boolean
  extraArgs: boolean
}) {
  const styles = useThemedStyles(stylesSheet)
  const t = useMobileTranslation()
  const none = t('automations.mobile.none', 'None')
  const graceLabel = (minutes: number) =>
    minutes === 0
      ? t('automations.mobile.catchUpNever', 'Never')
      : minutes % 60 === 0
        ? t('automations.mobile.catchUpHours', 'Within {{count}} hours', { count: minutes / 60 })
        : t('automations.mobile.catchUpMinutes', 'Within {{count}} minutes', { count: minutes })
  const graces = withSaved(GRACE_MINUTES, Number(draft.grace))
  const timeoutLabel = (seconds: number) =>
    seconds % 60 === 0
      ? t('automations.mobile.timeoutMinutes', '{{count}} min', { count: seconds / 60 })
      : t('automations.mobile.timeoutSeconds', '{{count}} sec', { count: seconds })
  const timeouts = withSaved(TIMEOUT_SECONDS, Number(draft.precheckTimeout))
  const text = (
    title: string,
    value: string,
    placeholder: string,
    onSubmit: (value: string) => void
  ) => present({ kind: 'text', title, value, placeholder, onSubmit })
  return (
    <View style={styles.content}>
      <SectionHeader title={t('automations.mobile.schedule', 'Schedule')} first />
      <ListGroup>
        <AutomationTimeZoneRow
          draft={draft}
          change={change}
          present={present}
          disabled={disabled}
        />
        <PickerRow
          label={t('automations.mobile.catchUp', 'Catch up missed runs')}
          value={draft.grace}
          options={graces.map((minutes) => ({
            value: String(minutes),
            label: graceLabel(minutes)
          }))}
          present={present}
          disabled={disabled}
          onSelect={(grace) => change({ grace })}
        />
      </ListGroup>
      <SectionHeader title={t('automations.mobile.workspace', 'Workspace')} />
      <ListGroup>
        {draft.workspaceMode === 'new_per_run' ? (
          <ListRow
            key="branch"
            title={t('automations.mobile.baseBranch', 'Base branch')}
            value={draft.baseBranch || t('automations.mobile.defaultBranch', 'Default')}
            navigates
            disabled={disabled}
            onPress={() =>
              text(
                t('automations.mobile.baseBranch', 'Base branch'),
                draft.baseBranch,
                t('automations.mobile.defaultBranch', 'Default'),
                (baseBranch) => change({ baseBranch })
              )
            }
          />
        ) : null}
        <PickerRow
          key="setup"
          label={t('automations.mobile.setupScript', 'Setup script')}
          value={draft.setupDecision}
          options={[
            { value: 'inherit', label: t('automations.mobile.setupProject', 'Project default') },
            { value: 'run', label: t('automations.mobile.setupRun', 'Run') },
            { value: 'skip', label: t('automations.mobile.setupSkip', 'Skip') }
          ]}
          present={present}
          disabled={disabled}
          onSelect={(setupDecision) => change({ setupDecision, setupDecisionEdited: true })}
        />
        {draft.workspaceMode === 'existing' ? (
          <ListRow
            key="reuse"
            title={t('automations.mobile.reuseAgentSession', 'Reuse agent session')}
            accessory={
              <MobileSwitch
                accessibilityLabel={t(
                  'automations.mobile.reuseAgentSession',
                  'Reuse agent session'
                )}
                value={draft.reuseSession}
                onValueChange={(reuseSession) => change({ reuseSession })}
                disabled={disabled}
              />
            }
          />
        ) : null}
        {extraArgs ? (
          <ListRow
            key="args"
            title={t('automations.mobile.agentArguments', 'Agent arguments')}
            value={draft.extraAgentArgs || none}
            navigates
            disabled={disabled}
            onPress={() =>
              text(
                t('automations.mobile.agentArguments', 'Agent arguments'),
                draft.extraAgentArgs,
                none,
                (extraAgentArgs) => change({ extraAgentArgs })
              )
            }
          />
        ) : null}
      </ListGroup>
      <SectionHeader title={t('automations.mobile.beforeEachRun', 'Before each run')} />
      <ListGroup>
        <ListRow
          title={t('automations.mobile.checkCommand', 'Check command')}
          value={draft.precheckCommand || none}
          navigates
          disabled={disabled}
          onPress={() =>
            text(
              t('automations.mobile.checkCommand', 'Check command'),
              draft.precheckCommand,
              none,
              (precheckCommand) => change({ precheckCommand })
            )
          }
        />
        {draft.precheckCommand ? (
          <PickerRow
            label={t('automations.mobile.timeLimit', 'Time limit')}
            value={draft.precheckTimeout}
            options={timeouts.map((seconds) => ({
              value: String(seconds),
              label: timeoutLabel(seconds)
            }))}
            present={present}
            disabled={disabled}
            onSelect={(precheckTimeout) => change({ precheckTimeout })}
          />
        ) : null}
      </ListGroup>
    </View>
  )
}

/** The automation's time zone, picked from every zone by city. */
export function AutomationTimeZoneRow(props: {
  draft: AutomationDraft
  change: (patch: Partial<AutomationDraft>) => void
  present: PresentAutomationSheet
  disabled: boolean
}) {
  const t = useMobileTranslation()
  return (
    <PickerRow
      label={t('automations.mobile.timeZone', 'Time zone')}
      value={props.draft.timezone}
      options={timeZoneOptions(props.draft.timezone)}
      searchable
      present={props.present}
      disabled={props.disabled}
      onSelect={(timezone) => props.change({ timezone })}
    />
  )
}

/** The preset values, plus a saved one the presets lack. */
function withSaved(presets: number[], saved: number): number[] {
  return Number.isFinite(saved) && !presets.includes(saved)
    ? [...presets, saved].sort((a, b) => a - b)
    : presets
}

/** Every zone the WebView knows, by city under its region, plus a saved one it doesn't. */
function timeZoneOptions(current: string): PickerOption[] {
  const zones =
    typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : []
  return (zones.includes(current) ? zones : [current, ...zones]).map((zone) => {
    const parts = zone.split('/')
    return {
      value: zone,
      label: (parts.at(-1) ?? zone).replaceAll('_', ' '),
      ...(parts.length > 1 ? { section: parts[0] } : {})
    }
  })
}

const stylesSheet = themedStyleSheet(() => ({
  content: { gap: spacing.sm, paddingBottom: spacing.xl }
}))
