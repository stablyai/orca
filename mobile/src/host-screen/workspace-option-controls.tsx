import { useState, type ComponentType } from 'react'
import { View } from 'react-native'
import { MobileSearchField } from '../components/MobileSearchField'
import { MobileSegmentedControl } from '../components/MobileSegmentedControl'
import * as viewOptions from '../../../src/shared/workspace-view/workspace-view-options'
import type {
  WorkspaceViewChoice,
  WorkspaceViewOptionKey
} from '../../../src/shared/workspace-view/workspace-view-options'
import * as hostVisibility from '../../../src/shared/workspace-view/workspace-host-visibility'
import type { ExecutionHostId } from '../../../src/shared/execution-host'
import type { WorktreeCardProperty } from '../../../src/shared/ui-chrome-types'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { hostScreenStyles as styles } from './host-screen-styles'
import { withoutPhoneHiddenProperties } from './phone-card-property-choices'
import type { HostScreenController } from './use-host-screen-controller'
import {
  groupByChoices,
  sortByChoices,
  projectOrderChoices,
  cardLayoutChoices,
  activityLayoutChoices,
  cardPropertyChoices,
  cardDisplayChoices
} from './workspace-option-controls-copy'
import { ListGroup } from '../components/list/ListGroup'
import { SectionHeader } from '../components/list/SectionHeader'
import { CheckRow, ChoiceRows, SwitchRow } from './workspace-option-rows'
import { choiceLabel, summarizeChecklist } from './workspace-option-values'
import type { Translate } from '../i18n/mobile-i18n'
import { useMobileTranslation } from '../i18n/use-mobile-translation'

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
      value: (props: WorkspaceOptionProps, t: Translate) => string
      Page: ComponentType<WorkspaceOptionProps>
    }

function checklistValue(
  checkedLabels: readonly string[],
  total: number,
  allLabel: string,
  t: Translate
): string {
  const count = checkedLabels.length
  const summary = summarizeChecklist(checkedLabels, total, allLabel)
  return count === 0 && count < total
    ? t('hostScreen.workspaceOptionControls.none', 'None')
    : count > 1 && count < total
      ? t('hostScreen.workspaceOptionControls.selectedCount', '{{count}} of {{total}}', {
          count,
          total
        })
      : summary
}

function hostsValue({ controller, hosts }: WorkspaceOptionProps, t: Translate): string {
  const visible = controller.state.view.filters.visibleHostIds
  const checked = visible ? hostVisibility.getCheckedHostRows(hosts, visible) : hosts
  return checklistValue(
    checked.map((host) => host.label),
    hosts.length,
    t('hostScreen.workspaceOptionControls.allHosts', 'All hosts'),
    t
  )
}

function HostsPage({ controller, hosts }: WorkspaceOptionProps) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  const { settings, state } = controller
  const visible = state.view.filters.visibleHostIds
  const checked = new Set(
    visible ? hostVisibility.getCheckedHostRows(hosts, visible).map((host) => host.id) : []
  )
  const write = (next: ExecutionHostId[] | null | undefined) => {
    if (next !== undefined) {
      settings.setFilter('visibleHostIds', next)
    }
  }
  return (
    <ListGroup style={styles.optionGroup}>
      <CheckRow
        key="all"
        label={t('hostScreen.workspaceOptionControls.allHosts', 'All hosts')}
        checked={!visible}
        onPress={() => write(hostVisibility.toggleAllVisibleHosts(hosts, visible))}
      />
      {hosts.map((host) => {
        const next = hostVisibility.toggleVisibleHostRow(hosts, visible, host)
        return (
          <CheckRow
            key={host.id}
            label={host.label}
            checked={checked.has(host.id)}
            disabled={next === undefined}
            onPress={() => write(next)}
          />
        )
      })}
    </ListGroup>
  )
}

function projectsValue({ controller }: WorkspaceOptionProps, t: Translate): string {
  const repos = controller.sectionsResult.uniqueRepos
  const selected = controller.state.view.filters.filterRepoIds
  const checked = selected.length === 0 ? repos : repos.filter((repo) => selected.includes(repo.id))
  return checklistValue(
    checked.map((repo) => repo.name),
    repos.length,
    t('hostScreen.workspaceOptionControls.allProjects', 'All projects'),
    t
  )
}

function ProjectsPage({ controller }: WorkspaceOptionProps) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  const { settings, state } = controller
  const [query, setQuery] = useState('')
  const needle = query.trim().toLowerCase()
  const selected = state.view.filters.filterRepoIds
  const repos = controller.sectionsResult.uniqueRepos.filter(
    (repo) => !needle || repo.name.toLowerCase().includes(needle)
  )
  return (
    <>
      <View style={styles.optionSearch}>
        <MobileSearchField
          value={query}
          onChangeText={setQuery}
          placeholder={t(
            'hostScreen.workspaceOptionControls.searchProjectsPlaceholder',
            'Search projects…'
          )}
          accessibilityLabel={t(
            'hostScreen.workspaceOptionControls.searchProjects',
            'Search projects'
          )}
        />
      </View>
      <ListGroup style={styles.optionGroup}>
        <CheckRow
          key="all"
          label={t('hostScreen.workspaceOptionControls.allProjects', 'All projects')}
          checked={selected.length === 0}
          onPress={() => settings.setFilter('filterRepoIds', [])}
        />
        {repos.map((repo) => (
          <CheckRow
            key={repo.key}
            label={repo.name}
            checked={selected.includes(repo.id)}
            onPress={() => settings.toggleRepoFilter(repo.id)}
            leading={<View style={[styles.filterRepoDot, { backgroundColor: repo.color }]} />}
          />
        ))}
      </ListGroup>
    </>
  )
}

function choicePage<Id extends string>(
  choices: (t: Translate) => readonly WorkspaceViewChoice<Id>[],
  selected: (controller: HostScreenController) => Id,
  onSelect: (controller: HostScreenController) => (id: Id) => void
): Extract<WorkspaceOptionControl, { kind: 'page' }> {
  return {
    kind: 'page',
    value: ({ controller }, t) => choiceLabel(choices(t), selected(controller)),
    Page: function ChoicePage({ controller }) {
      const t = useMobileTranslation()
      return (
        <ChoiceRows
          choices={choices(t)}
          selected={selected(controller)}
          onSelect={onSelect(controller)}
        />
      )
    }
  }
}

function CardPropertyRows(props: {
  controller: HostScreenController
  choices: readonly WorkspaceViewChoice<WorktreeCardProperty>[]
}) {
  useMobileColorScheme()
  const { settings, state } = props.controller
  return (
    <ListGroup style={styles.optionGroup}>
      {props.choices.map((choice) => (
        <CheckRow
          key={choice.id}
          label={choice.label}
          checked={state.view.worktreeCardProperties.includes(choice.id)}
          onPress={() => settings.toggleCardProperty(choice.id)}
        />
      ))}
    </ListGroup>
  )
}

function showPropertiesValue({ controller }: WorkspaceOptionProps, t: Translate): string {
  const value = viewOptions.getWorkspaceCardPropertiesValue(
    withoutPhoneHiddenProperties(controller.state.view.worktreeCardProperties),
    controller.state.view.compactWorktreeCards
  )
  return value === 'hover'
    ? t('hostScreen.workspaceOptionControls.hover', 'Hover')
    : value === null
      ? ''
      : String(value)
}

function propertiesPage(
  choices: (
    controller: HostScreenController,
    t: Translate
  ) => readonly WorkspaceViewChoice<WorktreeCardProperty>[],
  options: {
    value: (props: WorkspaceOptionProps, t: Translate) => string
    withAgentLayout: boolean
  }
): Extract<WorkspaceOptionControl, { kind: 'page' }> {
  const { withAgentLayout } = options
  return {
    kind: 'page',
    value: options.value,
    Page: function PropertiesPage({ controller }) {
      const t = useMobileTranslation()
      return (
        <>
          <CardPropertyRows controller={controller} choices={choices(controller, t)} />
          {withAgentLayout && (
            <>
              <SectionHeader
                title={t(
                  'hostScreen.workspaceOptionControls.agentActivityLayout',
                  'Agent activity layout'
                )}
              />
              <MobileSegmentedControl
                segments={activityLayoutChoices(t).map(({ id, label }) => ({
                  value: id,
                  label
                }))}
                selected={controller.state.view.agentActivityDisplayMode}
                onSelect={controller.settings.setAgentActivityDisplayMode}
                fill
                onSheet
                style={styles.optionSegmented}
              />
            </>
          )}
        </>
      )
    }
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
    Row: function GroupByRow({ controller }) {
      const t = useMobileTranslation()
      return (
        <MobileSegmentedControl
          segments={groupByChoices(t).map(({ id, label }) => ({ value: id, label }))}
          selected={controller.state.view.groupBy}
          onSelect={controller.settings.handleGroupChange}
          fill
          onSheet
          style={styles.optionSegmented}
        />
      )
    }
  },
  sortBy: choicePage(
    sortByChoices,
    (controller) => controller.state.view.sortBy,
    (controller) => controller.settings.handleSortChange
  ),
  projectOrderBy: choicePage(
    projectOrderChoices,
    (controller) => controller.projectOrderBy,
    (controller) => controller.settings.setProjectOrderBy
  ),
  cardLayout: choicePage(
    cardLayoutChoices,
    (controller) => (controller.state.view.compactWorktreeCards ? 'compact' : 'detailed'),
    (controller) => controller.settings.setCardLayout
  ),
  cardProperties: propertiesPage((_controller, t) => cardPropertyChoices(t), {
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
