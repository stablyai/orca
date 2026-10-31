import type { ReactNode } from 'react'
import type { ConnectionPresentationModel } from './use-mobile-tasks-connection-presentation'
import { translate as t } from '../i18n/mobile-i18n'
import { BottomDrawer, Linking, Text, View, type PickerOption } from './mobile-tasks-dependencies'
import { styles } from './mobile-tasks-legacy-styles'
import {
  LINEAR_GROUP_OPTIONS,
  LINEAR_ORDER_OPTIONS,
  LINEAR_VIEW_OPTIONS,
  PROJECT_VIEW_DEFAULT_SORT,
  SORT_OPTIONS
} from './mobile-tasks-legacy-foundation'
import { cycleMobileTasksGitHubProjectSort } from './mobile-tasks-github-project-pickers'
import { SheetHeader } from '../components/nav-bar/SheetHeader'
import { ListGroup } from '../components/list/ListGroup'
import { ListRow } from '../components/list/ListRow'
import { SectionHeader } from '../components/list/SectionHeader'

/** How many Filter & display settings differ from their defaults; the Filter chip shows it. */
export function mobileTasksFilterCount(model: ConnectionPresentationModel): number {
  const {
    githubMode,
    githubProjectHiddenFieldIds,
    githubProjectSortOverride,
    linearGroupBy,
    linearOrderBy,
    linearViewMode,
    provider,
    taskSort
  } = model
  if (provider === 'github' && githubMode === 'project') {
    return (githubProjectSortOverride ? 1 : 0) + (githubProjectHiddenFieldIds.size > 0 ? 1 : 0)
  }
  if (provider === 'linear') {
    return (
      (linearViewMode !== 'list' ? 1 : 0) +
      (linearGroupBy !== 'none' ? 1 : 0) +
      (linearOrderBy !== 'priority' ? 1 : 0)
    )
  }
  return taskSort !== 'updated' ? 1 : 0
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <>
      <SectionHeader title={title} />
      <ListGroup>{children}</ListGroup>
    </>
  )
}

// Single-choice rows that apply as they're tapped; the sheet stays open to change more.
function choiceSection<T extends string>(
  title: string,
  options: readonly PickerOption<T>[],
  selected: string,
  onSelect: (value: T) => void
) {
  return (
    <Section title={title}>
      {options.map((option) => (
        <ListRow
          key={option.value}
          title={option.label}
          subtitle={option.subtitle}
          selected={option.value === selected}
          disabled={option.disabled}
          onPress={() => onSelect(option.value)}
        />
      ))}
    </Section>
  )
}

// Rows with their own sheet open it in place of this one rather than stacking over it.
function openFromFilterSheet(model: ConnectionPresentationModel, open: () => void) {
  model.setShowFilterSheet(false)
  open()
}

function renderGitHubItemsSections(model: ConnectionPresentationModel) {
  const { githubIssueSourceLabel, githubIssueSourceRows, setShowGitHubIssueSourcePicker } = model
  return (
    <>
      {choiceSection(
        t('tasks.filterSheet.sortBy', 'Sort by'),
        SORT_OPTIONS,
        model.taskSort,
        model.setTaskSort
      )}
      {githubIssueSourceRows.length > 0 ? (
        <Section title={t('tasks.filterSheet.issueSource', 'Issue source')}>
          <ListRow
            title={t('tasks.filterSheet.issueSourceRow', 'Upstream or origin')}
            value={githubIssueSourceLabel}
            navigates
            onPress={() => openFromFilterSheet(model, () => setShowGitHubIssueSourcePicker(true))}
          />
        </Section>
      ) : null}
    </>
  )
}

function renderGitHubProjectSections(model: ConnectionPresentationModel) {
  const {
    activeGitHubProjectView,
    githubProjectAvailableSummaryFields,
    githubProjectFieldsLabel,
    githubProjectSortOptions,
    githubProjectSortOverride,
    githubProjectTable,
    selectedGitHubProjectViewUrl,
    setShowGitHubProjectFieldsPicker,
    setShowGitHubProjectViewPicker,
    visibleGitHubProjectRows
  } = model
  return (
    <>
      <Section title={t('tasks.filterSheet.view', 'View')}>
        <ListRow
          title={t('tasks.filterSheet.projectView', 'Project view')}
          subtitle={
            !githubProjectTable
              ? undefined
              : visibleGitHubProjectRows.length === 1
                ? t('tasks.filterSheet.projectItems_one', '{{count}} item', { count: 1 })
                : t('tasks.filterSheet.projectItems_other', '{{count}} items', {
                    count: visibleGitHubProjectRows.length
                  })
          }
          value={activeGitHubProjectView?.name ?? t('tasks.filterSheet.chooseView', 'Choose')}
          navigates
          disabled={!githubProjectTable && !activeGitHubProjectView}
          onPress={() => openFromFilterSheet(model, () => setShowGitHubProjectViewPicker(true))}
        />
        {selectedGitHubProjectViewUrl ? (
          <ListRow
            title={t('tasks.githubViewControls.openView', 'Open view in GitHub')}
            onPress={() => void Linking.openURL(selectedGitHubProjectViewUrl)}
          />
        ) : null}
      </Section>
      {githubProjectTable
        ? choiceSection(
            t('tasks.filterSheet.sortBy', 'Sort by'),
            githubProjectSortOptions,
            githubProjectSortOverride?.fieldId ?? PROJECT_VIEW_DEFAULT_SORT,
            (fieldId) => cycleMobileTasksGitHubProjectSort(model, fieldId)
          )
        : null}
      {githubProjectAvailableSummaryFields.length > 0 ? (
        <Section title={t('tasks.filterSheet.showOnRows', 'Show on rows')}>
          <ListRow
            title={t('tasks.filterSheet.projectFields', 'Project fields')}
            value={githubProjectFieldsLabel}
            navigates
            onPress={() => openFromFilterSheet(model, () => setShowGitHubProjectFieldsPicker(true))}
          />
        </Section>
      ) : null}
    </>
  )
}

function renderLinearSections(model: ConnectionPresentationModel) {
  const {
    linearWorkspaceLabel,
    linearWorkspaces,
    setShowLinearDisplayPicker,
    setShowLinearWorkspacePicker
  } = model
  return (
    <>
      {linearWorkspaces.length > 1 ? (
        <Section title={t('tasks.filterSheet.workspace', 'Workspace')}>
          <ListRow
            title={t('tasks.filterSheet.linearWorkspace', 'Linear workspace')}
            value={linearWorkspaceLabel}
            navigates
            onPress={() => openFromFilterSheet(model, () => setShowLinearWorkspacePicker(true))}
          />
        </Section>
      ) : null}
      {choiceSection(
        t('tasks.filterSheet.layout', 'Layout'),
        LINEAR_VIEW_OPTIONS,
        model.linearViewMode,
        model.setLinearViewMode
      )}
      {choiceSection(
        t('tasks.filterSheet.groupBy', 'Group by'),
        LINEAR_GROUP_OPTIONS,
        model.linearGroupBy,
        model.setLinearGroupBy
      )}
      {choiceSection(
        t('tasks.filterSheet.orderBy', 'Order by'),
        LINEAR_ORDER_OPTIONS,
        model.linearOrderBy,
        model.setLinearOrderBy
      )}
      <Section title={t('tasks.filterSheet.showOnRows', 'Show on rows')}>
        <ListRow
          title={t('tasks.filterSheet.displayProperties', 'Display properties')}
          navigates
          onPress={() => openFromFilterSheet(model, () => setShowLinearDisplayPicker(true))}
        />
      </Section>
    </>
  )
}

/** Sort, layout, grouping, fields and source in one sheet, so the chip row keeps only scopes. */
export function renderMobileTasksFilterSheet(model: ConnectionPresentationModel) {
  const { appliedQuery, githubMode, provider, setShowFilterSheet, showFilterSheet, taskUiReady } =
    model
  return (
    <BottomDrawer
      visible={taskUiReady && showFilterSheet}
      onClose={() => setShowFilterSheet(false)}
    >
      <View style={styles.filterSheetHeader}>
        <SheetHeader
          title={t('tasks.filterSheet.title', 'Filter & display')}
          trailing={{
            label: t('tasks.filterSheet.done', 'Done'),
            onPress: () => setShowFilterSheet(false)
          }}
        />
      </View>
      {provider === 'github' && githubMode === 'project' ? (
        renderGitHubProjectSections(model)
      ) : provider === 'github' ? (
        renderGitHubItemsSections(model)
      ) : provider === 'linear' ? (
        renderLinearSections(model)
      ) : (
        <>
          {choiceSection(
            t('tasks.filterSheet.sortBy', 'Sort by'),
            SORT_OPTIONS,
            model.taskSort,
            model.setTaskSort
          )}
          {provider === 'jira' && appliedQuery.trim().length > 0 ? (
            <Text style={styles.filterFootnote}>
              {t(
                'tasks.filterSheet.jqlReplacesPreset',
                'Your JQL search replaces the Show preset. Clear the search to pick one again.'
              )}
            </Text>
          ) : null}
        </>
      )}
    </BottomDrawer>
  )
}
