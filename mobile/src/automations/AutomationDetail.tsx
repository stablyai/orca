import { automationOrphanIssueText } from './automation-orphan-issue-copy'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useEffect, useState } from 'react'
import type { RpcClient } from '../transport/rpc-client'
import {
  loadAutomationTargets,
  automationSetupKey,
  workspaceMatchesSetup,
  type AutomationTargets
} from './automation-target-inventory'
import { Switch, Text, View } from 'react-native'
import { formatAutomationSchedule } from './automation-schedule-label'
import { MOBILE_TUI_AGENT_LABELS } from '../tasks/mobile-tui-agents'
import type { MobileAutomationRow } from './automation-reply-schema'
import { AutomationButton, AutomationMetadata } from './AutomationControls'
import { automationDate } from './automation-run-presentation'
import { automationStyles as styles } from './automation-styles'

export function AutomationDetail(props: {
  row: MobileAutomationRow
  client: RpcClient | null
  disabled: boolean
  onBack: () => void
  onToggle: (enabled: boolean) => void
  onRun: () => void
  onEdit: () => void
  onDelete: () => void
  onRuns: () => void
}) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  const { automation, item } = props.row
  const orphan = item.selector.kind === 'orphan'
  const client = props.client
  const [inventory, setInventory] = useState<{
    client: RpcClient
    generation: number | undefined
    targets: AutomationTargets
  } | null>(null)
  useEffect(() => {
    if (!client) {
      return
    }
    let active = true
    let readId = 0
    const refresh = () => {
      const id = ++readId
      setInventory(null)
      if (client.getState() !== 'connected') {
        return
      }
      const generation = client.getGeneration?.()
      const current = () =>
        active &&
        id === readId &&
        generation === client.getGeneration?.() &&
        client.getState() === 'connected'
      void loadAutomationTargets(client)
        .then((targets) => {
          if (current()) {
            setInventory({ client, generation, targets })
          }
        })
        .catch(() => {
          if (current()) {
            setInventory(null)
          }
        })
    }
    refresh()
    const stop = client.onStateChange(refresh)
    return () => {
      active = false
      stop()
    }
  }, [client])
  const targets =
    inventory?.client === client &&
    inventory?.generation === client?.getGeneration?.() &&
    client?.getState() === 'connected'
      ? inventory?.targets
      : undefined
  const owner = item.selector
  const hostId =
    owner.kind === 'self' ? 'local' : owner.kind === 'ssh' ? `ssh:${owner.targetId}` : null
  const registered =
    owner.kind === 'self' ||
    (owner.kind === 'ssh' &&
      targets?.sshTargets.some(
        (target) => target.id === owner.targetId && target.generation === owner.targetGeneration
      ))
  const context = automation.runContext
  const setups = registered
    ? (targets?.setups.filter(
        (entry) =>
          entry.hostId === hostId &&
          (context
            ? entry.projectId === context.projectId &&
              automationSetupKey(entry) ===
                automationSetupKey({ ...context, id: context.projectHostSetupId })
            : entry.repoId === automation.projectId)
      ) ?? [])
    : []
  const setup = setups.length === 1 ? setups[0] : undefined
  const workspaces =
    setup &&
    targets &&
    !targets.coverage.truncated &&
    targets.coverage.hostScope.hostIds.includes(setup.hostId) &&
    !targets.coverage.hostScope.omittedHostIds.includes(setup.hostId)
      ? targets.workspaces.filter(
          (entry) =>
            entry.worktreeId === automation.workspaceId && workspaceMatchesSetup(entry, setup)
        )
      : []
  const workspace = workspaces.length === 1 ? workspaces[0] : undefined
  return (
    <View style={styles.stack}>
      <AutomationButton
        label={t('automations.mobile.allAutomations', 'All automations')}
        onPress={props.onBack}
      />
      <View style={styles.row}>
        <Text style={[styles.title, styles.grow]}>{automation.name}</Text>
        <Switch
          accessibilityLabel={t('automations.mobile.runOnSchedule', 'Run {{name}} on schedule', {
            name: automation.name
          })}
          value={automation.enabled}
          onValueChange={props.onToggle}
          disabled={props.disabled}
        />
      </View>
      {item.selector.kind === 'orphan' ? (
        <Text style={styles.error}>{automationOrphanIssueText(item.selector.issue)}</Text>
      ) : null}
      <View style={styles.card}>
        <AutomationMetadata
          label={t('automations.mobile.schedule', 'Schedule')}
          value={`${formatAutomationSchedule(automation.rrule)} · ${automation.timezone}`}
        />
        <AutomationMetadata
          label={t('automations.mobile.nextRun', 'Next run')}
          value={
            automation.enabled
              ? automationDate(automation.nextRunAt, automation.timezone)
              : t('automations.mobile.noNextScheduledRun', 'No next scheduled run')
          }
        />
        <AutomationMetadata
          label={t('automations.mobile.agent', 'Agent')}
          value={MOBILE_TUI_AGENT_LABELS[automation.agentId]}
        />
        <AutomationMetadata
          label={t('automations.mobile.project', 'Project')}
          value={
            setup
              ? `${setup.label} · ${setup.path}`
              : t('automations.mobile.unavailable', 'Unavailable')
          }
        />
        <AutomationMetadata
          label={t('automations.mobile.workspace', 'Workspace')}
          value={
            automation.workspaceMode === 'existing'
              ? workspace?.displayName || t('automations.mobile.unavailable', 'Unavailable')
              : t('automations.mobile.newWorkspacePerRun', 'New workspace per run')
          }
        />
      </View>
      <Text style={styles.heading}>{t('automations.mobile.instructions', 'Instructions')}</Text>
      <Text selectable style={styles.text}>
        {automation.prompt}
      </Text>
      <View style={styles.row}>
        <View style={styles.grow}>
          <AutomationButton
            label={t('automations.mobile.runNow', 'Run now')}
            onPress={props.onRun}
            primary
            disabled={props.disabled || orphan}
          />
        </View>
        <AutomationButton
          label={t('automations.mobile.edit', 'Edit')}
          onPress={props.onEdit}
          disabled={props.disabled}
        />
      </View>
      <AutomationButton
        label={t('automations.mobile.viewAllRuns', 'View all runs')}
        onPress={props.onRuns}
      />
      <AutomationButton
        label={t('automations.mobile.deleteAutomation', 'Delete automation')}
        onPress={props.onDelete}
        destructive
        disabled={props.disabled}
      />
    </View>
  )
}
