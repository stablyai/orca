// The editor's Where: the project, a new or existing workspace, and the agent, each a picker row.
import { MobileAgentIcon } from '../components/icons/MobileAgentIcon'
import { ListGroup, ListRow } from '../components/list/ListGroup'
import type { PickerOption } from '../components/sheets/PickerModal'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { mobileTuiAgentLabel } from '../agents/mobile-tui-agents'
import type { MobileNewTabAgentOption } from '../session/agent-launch/mobile-new-tab-agent-options'
import type { MobileAutomation } from './automation-reply-schema'
import { automationSetupKey, type AutomationTargets } from './automation-target-inventory'
import type { AutomationDraft } from './automation-draft'
import type { PresentAutomationSheet } from './AutomationSheets'

const MORE_WORKSPACES = '\u0000more'
const NO_WORKSPACE = '\u0000none'

export function AutomationWhereRows(props: {
  draft: AutomationDraft
  current: MobileAutomation | undefined
  targets: AutomationTargets | null
  setup: AutomationTargets['setups'][number] | undefined
  workspaces: AutomationTargets['workspaces']
  agents: MobileNewTabAgentOption[]
  agentsLoading: boolean
  disabled: boolean
  present: PresentAutomationSheet
  change: (patch: Partial<AutomationDraft>) => void
  changeTarget: (patch: Partial<AutomationDraft>) => void
  onLoadMore: () => void
}) {
  const t = useMobileTranslation()
  const {
    draft,
    targets,
    setup,
    workspaces,
    agents,
    agentsLoading,
    disabled,
    present,
    change,
    changeTarget
  } = props
  const loading = t('automations.mobile.loading', 'Loading…')
  const projectOptions: PickerOption[] = [
    ...(targets?.setups
      .filter((entry) => !entry.hostId.startsWith('runtime:'))
      .map((entry) => ({
        value: automationSetupKey(entry),
        label: entry.label,
        subtitle: `${entry.displayName} · ${entry.path}`
      })) ?? []),
    ...(!setup && props.current
      ? [
          {
            value: draft.setupId,
            label: t('automations.mobile.savedTarget', 'Saved target'),
            subtitle: props.current.runContext?.path ?? props.current.projectId
          }
        ]
      : [])
  ]
  const workspace = workspaces.find((entry) => entry.worktreeId === draft.workspaceId)
  const existingSection = t('automations.mobile.existingWorkspaces', 'Existing workspaces')
  const workspaceOptions: PickerOption[] = [
    ...(setup?.kind === 'folder'
      ? []
      : [{ value: '', label: t('automations.mobile.newEachRun', 'New each run') }]),
    ...workspaces.map((entry) => ({
      value: entry.worktreeId,
      label: entry.displayName || entry.path,
      section: existingSection
    })),
    ...(props.current && draft.workspaceId && !workspace
      ? [
          {
            value: draft.workspaceId,
            label: t('automations.mobile.savedWorkspace', 'Saved workspace'),
            section: existingSection
          }
        ]
      : []),
    ...(targets?.coverage.truncated
      ? [
          {
            value: MORE_WORKSPACES,
            label: t('automations.mobile.loadMoreWorkspaces', 'Load more workspaces'),
            section: existingSection
          }
        ]
      : [])
  ]
  const agentOptions: PickerOption[] = agents.map((option) => ({
    value: option.agent,
    label: option.label,
    renderIcon: () => <MobileAgentIcon agentId={option.agent} size={17} />
  }))
  if (draft.agentId && !agentOptions.some((option) => option.value === draft.agentId)) {
    agentOptions.unshift({
      value: draft.agentId,
      label: mobileTuiAgentLabel(draft.agentId),
      renderIcon: () => <MobileAgentIcon agentId={draft.agentId ?? ''} size={17} />
    })
  }
  const pick = (
    title: string,
    options: PickerOption[],
    selected: string,
    onSelect: (value: string) => void
  ) =>
    present({ kind: 'picker', title, options, selected, onSelect, searchable: options.length > 8 })

  return (
    <ListGroup>
      <ListRow
        title={t('automations.mobile.project', 'Project')}
        value={
          setup?.label ??
          (props.current ? t('automations.mobile.savedTarget', 'Saved target') : loading)
        }
        navigates
        disabled={disabled}
        onPress={() =>
          pick(
            t('automations.mobile.project', 'Project'),
            projectOptions,
            draft.setupId,
            (setupId) => {
              const target = targets?.setups.find((entry) => automationSetupKey(entry) === setupId)
              changeTarget({
                setupId,
                workspaceId: '',
                workspaceMode: target?.kind === 'folder' ? 'existing' : draft.workspaceMode,
                reuseSession: false,
                agentId: null
              })
            }
          )
        }
      />
      <ListRow
        title={t('automations.mobile.workspace', 'Workspace')}
        value={
          draft.workspaceMode === 'new_per_run'
            ? t('automations.mobile.newEachRun', 'New each run')
            : draft.workspaceId
              ? workspace
                ? workspace.displayName || workspace.path
                : t('automations.mobile.savedWorkspace', 'Saved workspace')
              : t('automations.mobile.notSet', 'Not set')
        }
        navigates
        disabled={disabled}
        onPress={() =>
          pick(
            t('automations.mobile.workspace', 'Workspace'),
            workspaceOptions,
            // An existing workspace not picked yet ticks nothing.
            draft.workspaceMode === 'new_per_run' ? '' : draft.workspaceId || NO_WORKSPACE,
            (value) => {
              if (value === MORE_WORKSPACES) {
                props.onLoadMore()
              } else if (value === '') {
                changeTarget({ workspaceMode: 'new_per_run', workspaceId: '', reuseSession: false })
              } else {
                // The mode, then the workspace, as two picks: each restores what was set under it.
                if (draft.workspaceMode !== 'existing') {
                  changeTarget({ workspaceMode: 'existing', reuseSession: false })
                }
                changeTarget({ workspaceId: value, agentId: props.current?.agentId ?? null })
              }
            }
          )
        }
      />
      <ListRow
        title={t('automations.mobile.agent', 'Agent')}
        value={
          agentsLoading || !targets
            ? loading
            : draft.agentId
              ? mobileTuiAgentLabel(draft.agentId)
              : t('automations.mobile.notSet', 'Not set')
        }
        valueIcon={
          draft.agentId && !agentsLoading ? (
            <MobileAgentIcon agentId={draft.agentId} size={13} />
          ) : undefined
        }
        navigates
        disabled={disabled || agentsLoading || agentOptions.length === 0}
        onPress={() =>
          pick(
            t('automations.mobile.agent', 'Agent'),
            agentOptions,
            draft.agentId ?? '',
            (agentId) => change({ agentId })
          )
        }
      />
    </ListGroup>
  )
}
