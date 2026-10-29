import { useState, type ComponentType } from 'react'
import { Text, View } from 'react-native'
import { MobileSearchField } from '../components/MobileSearchField'
import { MobileSegmentedControl } from '../components/MobileSegmentedControl'
import {
  WORKSPACE_AGENT_ACTIVITY_LAYOUT_CHOICES,
  WORKSPACE_CARD_DISPLAY_CHOICES,
  WORKSPACE_CARD_LAYOUT_CHOICES,
  WORKSPACE_CARD_PROPERTY_CHOICES,
  WORKSPACE_GROUP_BY_CHOICES,
  WORKSPACE_PROJECT_ORDER_CHOICES,
  WORKSPACE_SORT_BY_CHOICES,
  getWorkspaceCardDisplayChoiceLabel,
  getWorkspaceCardPropertiesValue,
  type WorkspaceViewChoice,
  type WorkspaceViewOptionKey
} from '../../../src/shared/workspace-view/workspace-view-options'
import {
  getCheckedHostRows,
  toggleAllVisibleHosts,
  toggleVisibleHostRow
} from '../../../src/shared/workspace-view/workspace-host-visibility'
import type { ExecutionHostId } from '../../../src/shared/execution-host'
import type { WorktreeCardProperty } from '../../../src/shared/ui-chrome-types'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { hostScreenStyles as styles } from './host-screen-styles'
import {
  phoneCardPropertyChoices,
  withoutPhoneHiddenProperties
} from './phone-card-property-choices'
import type { HostScreenController } from './use-host-screen-controller'
import { CheckRow, ChoiceRows, OptionRowList, SwitchRow } from './workspace-option-rows'
import { choiceLabel, summarizeChecklist } from './workspace-option-values'

export type WorkspaceOptionHost = { id: ExecutionHostId; label: string }

export type WorkspaceOptionProps = {
  controller: HostScreenController
  hosts: readonly WorkspaceOptionHost[]
  label: string
}

// Inline options render on the main sheet, framed inside the card when requested; others show a value and open a page.
export type WorkspaceOptionControl =
  | { kind: 'inline'; framed: boolean; Row: ComponentType<WorkspaceOptionProps> }
  | {
      kind: 'page'
      value: (props: WorkspaceOptionProps) => string
      Page: ComponentType<WorkspaceOptionProps>
    }

const CARD_PROPERTY_CHOICES = phoneCardPropertyChoices(WORKSPACE_CARD_PROPERTY_CHOICES)

// Infer project-group availability from folder rows: hosts list folder workspaces only under a group.
function cardDisplayChoices(
  controller: HostScreenController
): WorkspaceViewChoice<WorktreeCardProperty>[] {
  const hasProjectGroups = controller.state.worktrees.some(
    (row) => row.workspaceKind === 'folder-workspace'
  )
  return phoneCardPropertyChoices(WORKSPACE_CARD_DISPLAY_CHOICES).map((choice) => ({
    id: choice.id,
    label: getWorkspaceCardDisplayChoiceLabel(choice, hasProjectGroups)
  }))
}

function hostsValue({ controller, hosts }: WorkspaceOptionProps): string {
  const visible = controller.state.view.filters.visibleHostIds
  const checked = visible ? getCheckedHostRows(hosts, visible) : hosts
  return summarizeChecklist(
    checked.map((host) => host.label),
    hosts.length,
    'All hosts'
  )
}

function HostsPage({ controller, hosts }: WorkspaceOptionProps) {
  useMobileColorScheme()
  const { settings, state } = controller
  const visible = state.view.filters.visibleHostIds
  const checked = new Set(visible ? getCheckedHostRows(hosts, visible).map((host) => host.id) : [])
  const write = (next: ExecutionHostId[] | null | undefined) => {
    if (next !== undefined) {
      settings.setFilter('visibleHostIds', next)
    }
  }
  return (
    <View style={styles.filterGroup}>
      <OptionRowList>
        {[
          <CheckRow
            key="all"
            label="All hosts"
            checked={!visible}
            onPress={() => write(toggleAllVisibleHosts(hosts, visible))}
          />,
          ...hosts.map((host) => {
            const next = toggleVisibleHostRow(hosts, visible, host)
            return (
              <CheckRow
                key={host.id}
                label={host.label}
                checked={checked.has(host.id)}
                disabled={next === undefined}
                onPress={() => write(next)}
              />
            )
          })
        ]}
      </OptionRowList>
    </View>
  )
}

function projectsValue({ controller }: WorkspaceOptionProps): string {
  const repos = controller.sectionsResult.uniqueRepos
  const selected = controller.state.view.filters.filterRepoIds
  const checked = selected.length === 0 ? repos : repos.filter((repo) => selected.includes(repo.id))
  return summarizeChecklist(
    checked.map((repo) => repo.name),
    repos.length,
    'All projects'
  )
}

function ProjectsPage({ controller }: WorkspaceOptionProps) {
  useMobileColorScheme()
  const { settings, state } = controller
  const [query, setQuery] = useState('')
  const needle = query.trim().toLowerCase()
  const selected = state.view.filters.filterRepoIds
  const repos = controller.sectionsResult.uniqueRepos.filter(
    (repo) => !needle || repo.name.toLowerCase().includes(needle)
  )
  return (
    <View style={styles.filterGroup}>
      <View style={styles.optionSearch}>
        <MobileSearchField
          value={query}
          onChangeText={setQuery}
          placeholder="Search projects…"
          accessibilityLabel="Search projects"
        />
      </View>
      <OptionRowList>
        {[
          <CheckRow
            key="all"
            label="All projects"
            checked={selected.length === 0}
            onPress={() => settings.setFilter('filterRepoIds', [])}
          />,
          ...repos.map((repo) => (
            <CheckRow
              key={repo.key}
              label={repo.name}
              checked={selected.includes(repo.id)}
              onPress={() => settings.toggleRepoFilter(repo.id)}
              leading={<View style={[styles.filterRepoDot, { backgroundColor: repo.color }]} />}
            />
          ))
        ]}
      </OptionRowList>
    </View>
  )
}

function choicePage<Id extends string>(
  choices: readonly WorkspaceViewChoice<Id>[],
  selected: (controller: HostScreenController) => Id,
  onSelect: (controller: HostScreenController) => (id: Id) => void
): Extract<WorkspaceOptionControl, { kind: 'page' }> {
  return {
    kind: 'page',
    value: ({ controller }) => choiceLabel(choices, selected(controller)),
    Page: ({ controller }) => (
      <View style={styles.filterGroup}>
        <ChoiceRows
          choices={choices}
          selected={selected(controller)}
          onSelect={onSelect(controller)}
        />
      </View>
    )
  }
}

function CardPropertyRows(props: {
  controller: HostScreenController
  choices: readonly WorkspaceViewChoice<WorktreeCardProperty>[]
}) {
  useMobileColorScheme()
  const { settings, state } = props.controller
  return (
    <View style={styles.filterGroup}>
      <OptionRowList>
        {props.choices.map((choice) => (
          <CheckRow
            key={choice.id}
            label={choice.label}
            checked={state.view.worktreeCardProperties.includes(choice.id)}
            onPress={() => settings.toggleCardProperty(choice.id)}
          />
        ))}
      </OptionRowList>
    </View>
  )
}

function showPropertiesValue({ controller }: WorkspaceOptionProps): string {
  const value = getWorkspaceCardPropertiesValue(
    withoutPhoneHiddenProperties(controller.state.view.worktreeCardProperties),
    controller.state.view.compactWorktreeCards
  )
  return value === 'hover' ? 'Hover' : value === null ? '' : String(value)
}

function propertiesPage(
  choices: (
    controller: HostScreenController
  ) => readonly WorkspaceViewChoice<WorktreeCardProperty>[],
  options: { value: (props: WorkspaceOptionProps) => string; withAgentLayout: boolean }
): Extract<WorkspaceOptionControl, { kind: 'page' }> {
  const { withAgentLayout } = options
  return {
    kind: 'page',
    value: options.value,
    Page: ({ controller }) => (
      <>
        <CardPropertyRows controller={controller} choices={choices(controller)} />
        {withAgentLayout && (
          <>
            <Text style={styles.filterSectionLabel}>Agent activity layout</Text>
            <MobileSegmentedControl
              segments={WORKSPACE_AGENT_ACTIVITY_LAYOUT_CHOICES.map(({ id, label }) => ({
                value: id,
                label
              }))}
              selected={controller.state.view.agentActivityDisplayMode}
              onSelect={controller.settings.setAgentActivityDisplayMode}
              fill
              style={styles.optionSegmented}
            />
          </>
        )}
      </>
    )
  }
}

function filterSwitch(
  key: Extract<WorkspaceViewOptionKey, `hide${string}` | `always${string}`>
): WorkspaceOptionControl {
  const isExemption = key === 'alwaysShowDefaultBranchWorkspace'
  return {
    kind: 'inline',
    framed: true,
    Row: function FilterSwitch({ controller, label }: WorkspaceOptionProps) {
      const value = controller.state.view.filters[key]
      // The exemption's absence means on (#8873), so only an explicit false reads as off.
      const on = isExemption ? value !== false : value === true
      return (
        <SwitchRow
          label={label}
          value={on}
          indent={isExemption}
          onChange={(next) => controller.settings.setFilter(key, next)}
        />
      )
    }
  }
}

export const WORKSPACE_OPTION_CONTROLS: Record<WorkspaceViewOptionKey, WorkspaceOptionControl> = {
  hosts: { kind: 'page', value: hostsValue, Page: HostsPage },
  projects: { kind: 'page', value: projectsValue, Page: ProjectsPage },
  groupBy: {
    kind: 'inline',
    framed: false,
    Row: ({ controller }) => (
      <MobileSegmentedControl
        segments={WORKSPACE_GROUP_BY_CHOICES.map(({ id, label }) => ({ value: id, label }))}
        selected={controller.state.view.groupBy}
        onSelect={controller.settings.handleGroupChange}
        fill
        style={styles.optionSegmented}
      />
    )
  },
  sortBy: choicePage(
    WORKSPACE_SORT_BY_CHOICES,
    (controller) => controller.state.view.sortBy,
    (controller) => controller.settings.handleSortChange
  ),
  projectOrderBy: choicePage(
    WORKSPACE_PROJECT_ORDER_CHOICES,
    (controller) => controller.projectOrderBy,
    (controller) => controller.settings.setProjectOrderBy
  ),
  cardLayout: choicePage(
    WORKSPACE_CARD_LAYOUT_CHOICES,
    (controller) => (controller.state.view.compactWorktreeCards ? 'compact' : 'detailed'),
    (controller) => controller.settings.setCardLayout
  ),
  cardProperties: propertiesPage(() => CARD_PROPERTY_CHOICES, {
    value: showPropertiesValue,
    withAgentLayout: true
  }),
  cardDisplay: propertiesPage(cardDisplayChoices, { value: () => '', withAgentLayout: false }),
  hideSleepingWorkspaces: filterSwitch('hideSleepingWorkspaces'),
  alwaysShowDefaultBranchWorkspace: filterSwitch('alwaysShowDefaultBranchWorkspace'),
  hideDefaultBranchWorkspace: filterSwitch('hideDefaultBranchWorkspace'),
  hideAutomationGeneratedWorkspaces: filterSwitch('hideAutomationGeneratedWorkspaces'),
  hideCliCreatedWorkspaces: filterSwitch('hideCliCreatedWorkspaces'),
  hideWorkspacesFromOtherDevices: filterSwitch('hideWorkspacesFromOtherDevices'),
  hideDetachedHeadWorkspaces: filterSwitch('hideDetachedHeadWorkspaces')
}
