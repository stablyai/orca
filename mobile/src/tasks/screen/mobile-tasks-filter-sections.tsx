import type { ConnectionPresentationModel } from '../screen-state/use-mobile-tasks-connection-presentation'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import type { OptionPagerControls } from '../../components/bottom-drawer/BottomDrawer'
import { openExternalLink } from '../../platform/external-links/external-link'
import type { PickerOption } from '../../components/sheets/PickerModal'
import { ListGroup, ListRow, SectionHeader } from '../../components/list/ListGroup'
import { spacing } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import {
  GITLAB_FILTER_OPTIONS,
  GITLAB_VIEW_OPTIONS,
  LINEAR_FILTER_OPTIONS,
  LINEAR_GROUP_OPTIONS,
  LINEAR_ORDER_OPTIONS,
  LINEAR_VIEW_OPTIONS,
  PROJECT_VIEW_DEFAULT_SORT
} from '../task-list/mobile-tasks-options'
import { JIRA_FILTER_OPTIONS } from '../task-list/mobile-task-view-options'
import { cycleMobileTasksGitHubProjectSort } from '../project-board/mobile-tasks-github-project-pickers'
import {
  selectMobileTasksGitHubPreset,
  selectMobileTasksGitLabView,
  selectMobileTasksJiraFilter,
  selectMobileTasksLinearFilter
} from './mobile-tasks-filter-selection'
import type { MobileTasksFilterPageKey } from './mobile-tasks-filter-pages'

function optionLabel<T extends string>(options: readonly PickerOption<T>[], value: string): string {
  return options.find((option) => option.value === value)?.label ?? ''
}

// Single-choice rows that apply as they're tapped; the sheet stays open to change more.
export function ChoiceSection<T extends string>(props: {
  title: string
  options: readonly PickerOption<T>[]
  selected: string
  onSelect: (value: T) => void
  defaultValue?: string
  /** Options whose subtitle carries state, e.g. a project sort's direction. */
  withSubtitles?: boolean
  onLongSelect?: (value: T) => void
}) {
  const t = useMobileTranslation()
  return (
    <>
      <SectionHeader title={props.title} />
      <ListGroup style={styles.group}>
        {props.options.map((option) => (
          <ListRow
            key={option.value}
            title={option.label}
            subtitle={props.withSubtitles ? option.subtitle : undefined}
            value={
              option.value === props.defaultValue
                ? t('tasks.providerViewProjection.default', 'Default')
                : undefined
            }
            selected={option.value === props.selected}
            disabled={option.disabled}
            onPress={() => props.onSelect(option.value)}
            onLongPress={props.onLongSelect ? () => props.onLongSelect?.(option.value) : undefined}
          />
        ))}
      </ListGroup>
    </>
  )
}

type DrillRow = {
  page: MobileTasksFilterPageKey
  title: string
  value?: string
  onOpen?: () => void
}

function DrillGroup({
  rows,
  pager
}: {
  rows: readonly (DrillRow | false)[]
  pager: OptionPagerControls<MobileTasksFilterPageKey>
}) {
  const shown = rows.filter((row): row is DrillRow => row !== false)
  if (shown.length === 0) {
    return null
  }
  return (
    <ListGroup style={[styles.group, styles.drillGroup]}>
      {shown.map((row) => (
        <ListRow
          key={row.page}
          title={row.title}
          value={row.value}
          navigates
          onPress={() => {
            row.onOpen?.()
            pager.open(row.page)
          }}
        />
      ))}
    </ListGroup>
  )
}

export function GitHubItemsSections({
  model,
  pager
}: {
  model: ConnectionPresentationModel
  pager: OptionPagerControls<MobileTasksFilterPageKey>
}) {
  const t = useMobileTranslation()
  return (
    <>
      <ChoiceSection
        title={t('tasks.filterSheet.which', 'Which')}
        options={model.githubPresetOptions}
        selected={model.githubPreset}
        // Marked only once someone picked their own default (long-press); Open issues is the given one.
        defaultValue={
          model.defaultGitHubPreset === 'issues' ? undefined : model.defaultGitHubPreset
        }
        onSelect={(preset) => selectMobileTasksGitHubPreset(model, preset)}
        onLongSelect={model.persistDefaultGitHubPreset}
      />
      <DrillGroup
        pager={pager}
        rows={[
          {
            page: 'repos',
            title: t('tasks.filterSheet.repositories', 'Repositories'),
            value: model.repoPickerLabel
          },
          {
            page: 'sort',
            title: t('tasks.filterSheet.sort', 'Sort'),
            value: model.sortLabel
          },
          model.githubIssueSourceRows.length > 0 && {
            page: 'issueSource',
            title: t('tasks.filterSheet.issueSource', 'Issue source'),
            value: model.githubIssueSourceLabel
          }
        ]}
      />
    </>
  )
}

export function GitHubProjectSections({
  model,
  pager
}: {
  model: ConnectionPresentationModel
  pager: OptionPagerControls<MobileTasksFilterPageKey>
}) {
  const t = useMobileTranslation()
  const { activeGitHubProjectView, githubProjectTable, selectedGitHubProjectViewUrl } = model
  return (
    <>
      <DrillGroup
        pager={pager}
        rows={[
          {
            page: 'project',
            title: t('tasks.filterSheet.project', 'Project'),
            value: model.activeProjectLabel
          },
          (githubProjectTable !== null || activeGitHubProjectView !== null) && {
            page: 'projectView',
            title: t('tasks.filterSheet.view', 'View'),
            value: activeGitHubProjectView?.name
          },
          model.githubProjectAvailableSummaryFields.length > 0 && {
            page: 'projectFields',
            title: t('tasks.filterSheet.fields', 'Fields'),
            value: model.githubProjectFieldsLabel
          }
        ]}
      />
      {githubProjectTable ? (
        <ChoiceSection
          title={t('tasks.filterSheet.sort', 'Sort')}
          options={model.githubProjectSortOptions}
          withSubtitles
          selected={model.githubProjectSortOverride?.fieldId ?? PROJECT_VIEW_DEFAULT_SORT}
          onSelect={(fieldId) => cycleMobileTasksGitHubProjectSort(model, fieldId)}
        />
      ) : null}
      {selectedGitHubProjectViewUrl ? (
        <ListGroup style={styles.group}>
          <ListRow
            title={t('tasks.githubViewControls.openView', 'Open view in GitHub')}
            accent
            onPress={() => void openExternalLink(selectedGitHubProjectViewUrl)}
          />
        </ListGroup>
      ) : null}
    </>
  )
}

export function GitLabSections({
  model,
  pager
}: {
  model: ConnectionPresentationModel
  pager: OptionPagerControls<MobileTasksFilterPageKey>
}) {
  const t = useMobileTranslation()
  return (
    <>
      <ChoiceSection
        title={t('tasks.filterSheet.show', 'Show')}
        options={GITLAB_VIEW_OPTIONS}
        selected={model.gitlabView}
        onSelect={(view) => selectMobileTasksGitLabView(model, view)}
      />
      {model.gitlabView === 'project' ? (
        <ChoiceSection
          title={t('tasks.filterSheet.which', 'Which')}
          options={GITLAB_FILTER_OPTIONS}
          selected={model.gitlabFilter}
          onSelect={model.setGitlabFilter}
        />
      ) : null}
      <DrillGroup
        pager={pager}
        rows={[
          {
            page: 'repos',
            title: t('tasks.filterSheet.repositories', 'Repositories'),
            value: model.repoPickerLabel
          },
          { page: 'sort', title: t('tasks.filterSheet.sort', 'Sort'), value: model.sortLabel }
        ]}
      />
    </>
  )
}

export function LinearSections({
  model,
  pager
}: {
  model: ConnectionPresentationModel
  pager: OptionPagerControls<MobileTasksFilterPageKey>
}) {
  const t = useMobileTranslation()
  return (
    <>
      <ChoiceSection
        title={t('tasks.filterSheet.which', 'Which')}
        options={LINEAR_FILTER_OPTIONS}
        selected={model.linearFilter}
        onSelect={(filter) => selectMobileTasksLinearFilter(model, filter)}
      />
      <DrillGroup
        pager={pager}
        rows={[
          {
            page: 'linearTeams',
            title: t('tasks.filterSheet.teams', 'Teams'),
            value: model.linearTeamLabel
          },
          model.linearWorkspaces.length > 1 && {
            page: 'linearWorkspace',
            title: t('tasks.filterSheet.workspace', 'Workspace'),
            value: model.linearWorkspaceLabel,
            // Pin the account host the list came from, so the switch reaches the same Linear account.
            onOpen: model.bindLinearAccountHost
          }
        ]}
      />
      <DrillGroup
        pager={pager}
        rows={[
          {
            page: 'linearLayout',
            title: t('tasks.filterSheet.layout', 'Layout'),
            value: optionLabel(LINEAR_VIEW_OPTIONS, model.linearViewMode)
          },
          {
            page: 'linearGroup',
            title: t('tasks.filterSheet.groupBy', 'Group by'),
            value: optionLabel(LINEAR_GROUP_OPTIONS, model.linearGroupBy)
          },
          {
            page: 'linearOrder',
            title: t('tasks.filterSheet.orderBy', 'Order by'),
            value: optionLabel(LINEAR_ORDER_OPTIONS, model.linearOrderBy)
          },
          { page: 'linearDisplay', title: t('tasks.filterSheet.showOnRows', 'Show on rows') }
        ]}
      />
    </>
  )
}

export function JiraSections({
  model,
  pager
}: {
  model: ConnectionPresentationModel
  pager: OptionPagerControls<MobileTasksFilterPageKey>
}) {
  const t = useMobileTranslation()
  // A JQL search replaces the preset, so the choices wait until the search is cleared.
  const searchReplacesPreset = model.appliedQuery.trim().length > 0
  return (
    <>
      <ChoiceSection
        title={
          searchReplacesPreset
            ? t('tasks.filterSheet.whichAfterSearch', 'Which (clear the search to change)')
            : t('tasks.filterSheet.which', 'Which')
        }
        options={JIRA_FILTER_OPTIONS.map((option) => ({
          ...option,
          disabled: searchReplacesPreset
        }))}
        selected={searchReplacesPreset ? '' : model.jiraFilter}
        onSelect={(filter) => selectMobileTasksJiraFilter(model, filter)}
      />
      <DrillGroup
        pager={pager}
        rows={[
          model.jiraConnection.sites.length > 1 && {
            page: 'jiraSite',
            title: t('tasks.filterSheet.site', 'Site'),
            value: model.jiraSiteChipLabel
          },
          { page: 'sort', title: t('tasks.filterSheet.sort', 'Sort'), value: model.sortLabel }
        ]}
      />
    </>
  )
}

const styles = themedStyleSheet(() => ({
  group: { marginBottom: spacing.md },
  drillGroup: { marginTop: spacing.xs }
}))
