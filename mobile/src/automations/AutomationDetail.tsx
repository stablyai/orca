import { automationOrphanIssueText } from './automation-orphan-issue-copy'
import type { Translate } from '../i18n/mobile-i18n'
import { intlLocaleFor } from '../i18n/ui-intl-locale'
import { useMobileTranslation, useMobileUiLocale } from '../i18n/use-mobile-translation'
import { useThemedStyles } from '../theme/themed-styles'
import { useEffect, useRef, useState } from 'react'
import { View, type HostInstance } from 'react-native'
import { Ellipsis, History, Pencil, Play, Trash2 } from 'lucide-react-native'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import {
  loadAutomationTargets,
  automationSetupKey,
  workspaceMatchesSetup,
  type AutomationTargets
} from './automation-target-inventory'
import { MobileSwitch } from '../components/controls/MobileSwitch'
import { MobileAgentIcon } from '../components/icons/MobileAgentIcon'
import { ListRow } from '../components/list/ListGroup'
import { useBackClaim } from '../navigation/use-back-claim'
import type { AutomationHeaderBar } from './AutomationControls'
import { automationNextRunShortLabel } from './automation-next-run-label'
import { NavBarButton } from '../components/nav-bar/NavBarButton'
import { PullDownMenu } from '../components/nav-bar/PullDownMenu'
import { SheetPrimaryButton } from '../components/sheets/SheetPrimaryButton'
import { ConfirmModal } from '../components/sheets/ConfirmModal'
import { useMobilePendingControl } from '../components/controls/use-mobile-pending-control'
import { SettingsNote, SettingsSection } from '../settings/settings-screen-frame'
import { automationScheduleText } from './automation-schedule-label'
import { mobileTuiAgentLabel } from '../agents/mobile-tui-agents'
import type { MobileAutomationRow } from './automation-reply-schema'
import type { AutomationEditorSection } from './AutomationEditor'
import { automationStylesSheet } from './automation-styles'

export function AutomationDetail(props: {
  row: MobileAutomationRow
  client: RpcClient | null
  disabled: boolean
  projectName: string | undefined
  onBack: () => void
  onToggle: (enabled: boolean) => void
  /** Opens the editor on the section a row shows. */
  onEdit: (section: AutomationEditorSection) => void
}) {
  const t = useMobileTranslation()
  const intlLocale = intlLocaleFor(useMobileUiLocale())
  const { automation, item } = props.row
  // Back returns to the list, as the bar's back button does.
  useBackClaim(() => {
    props.onBack()
    return true
  })
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
  const unavailable = t('automations.mobile.unavailable', 'Unavailable')
  const editable = !props.disabled && item.selector.kind !== 'orphan'
  const drill = (section: AutomationEditorSection) =>
    editable ? { navigates: true, onPress: () => props.onEdit(section) } : {}
  return (
    <>
      {item.selector.kind === 'orphan' ? (
        <SettingsNote error>{automationOrphanIssueText(item.selector.issue, t)}</SettingsNote>
      ) : null}
      <SettingsSection first>
        <ListRow
          title={t('automations.mobile.on', 'On')}
          accessory={
            <MobileSwitch
              accessibilityLabel={t(
                'automations.mobile.runOnSchedule',
                'Run {{name}} on schedule',
                { name: automation.name }
              )}
              value={automation.enabled}
              onValueChange={props.onToggle}
              disabled={props.disabled}
            />
          }
        />
      </SettingsSection>
      <SettingsSection title={t('automations.mobile.schedule', 'Schedule')}>
        <ListRow
          title={t('automations.mobile.repeats', 'Repeats')}
          value={automationScheduleText(automation, t, intlLocale)}
          {...drill('when')}
        />
        <ListRow
          title={t('automations.mobile.agent', 'Agent')}
          value={mobileTuiAgentLabel(automation.agentId)}
          valueIcon={<MobileAgentIcon agentId={automation.agentId} size={13} />}
          {...drill('where')}
        />
        <ListRow
          title={t('automations.mobile.project', 'Project')}
          value={props.projectName ?? setup?.label ?? unavailable}
          {...drill('where')}
        />
        <ListRow
          title={t('automations.mobile.workspace', 'Workspace')}
          value={
            automation.workspaceMode === 'existing'
              ? workspace?.displayName || unavailable
              : t('automations.mobile.newEachRun', 'New each run')
          }
          {...drill('where')}
        />
      </SettingsSection>
      <SettingsSection title={t('automations.mobile.instructions', 'Instructions')}>
        <ListRow title={automation.prompt} wrapTitle {...drill('prompt')} />
      </SettingsSection>
    </>
  )
}

type DetailMenuActions = {
  disabled: boolean
  onEdit: () => void
  onRuns: () => void
  onDelete: () => void
}

/** The detail's bar: the automation's name over its next run, and ⋯. */
export function automationDetailBar(
  row: MobileAutomationRow,
  onBack: () => void,
  actions: DetailMenuActions,
  t: Translate,
  intlLocale: string
): AutomationHeaderBar {
  return {
    page: {
      title: row.automation.name,
      subtitle: automationNextRunShortLabel(row.automation, t, intlLocale),
      onBack
    },
    trailing: <AutomationDetailMenu {...actions} name={row.automation.name} />
  }
}

/** The detail's ⋯ in the bar: Edit, All runs and Delete, which asks first. */
function AutomationDetailMenu(props: DetailMenuActions & { name: string }) {
  const t = useMobileTranslation()
  const [open, setOpen] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const anchor = useRef<HostInstance>(null)
  return (
    <>
      <ConfirmModal
        visible={confirming}
        title={t('common.delete', 'Delete')}
        message={t(
          'automations.mobile.deleteRetained',
          'Delete “{{name}}” and its retained runs?',
          { name: props.name }
        )}
        confirmLabel={t('common.delete', 'Delete')}
        destructive
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false)
          props.onDelete()
        }}
      />
      <NavBarButton
        ref={anchor}
        icon={Ellipsis}
        accessibilityLabel={t('automations.mobile.moreActions', 'More actions')}
        onPress={() => setOpen(true)}
      />
      <PullDownMenu
        visible={open}
        anchorRef={anchor}
        onClose={() => setOpen(false)}
        groups={[
          [
            {
              label: t('automations.mobile.edit', 'Edit'),
              icon: Pencil,
              disabled: props.disabled,
              onPress: props.onEdit
            },
            {
              label: t('automations.mobile.allRuns', 'All runs'),
              icon: History,
              onPress: props.onRuns
            }
          ],
          [
            {
              label: t('common.delete', 'Delete'),
              icon: Trash2,
              destructive: true,
              disabled: props.disabled,
              closeBeforePress: true,
              onPress: () => setConfirming(true)
            }
          ]
        ]}
      />
    </>
  )
}

/** Run now, the detail's one action, in the bar at the foot of the screen. */
export function AutomationRunNowBar(props: { disabled: boolean; onRun: () => Promise<boolean> }) {
  const t = useMobileTranslation()
  const styles = useThemedStyles(automationStylesSheet)
  const control = useMobilePendingControl<'run'>()
  return (
    <View style={styles.bottomBar}>
      <SheetPrimaryButton
        label={t('automations.mobile.runNow', 'Run now')}
        icon={Play}
        busy={control.pending === 'run'}
        disabled={props.disabled}
        onPress={() => void control.run('run', props.onRun)}
      />
    </View>
  )
}
