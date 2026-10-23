import type { ReactNode } from 'react'
import type { PageChromeModel } from './use-mobile-tasks-page-chrome'
import type { ConnectionPresentationModel } from './use-mobile-tasks-connection-presentation'
import {
  BottomDrawer,
  Linking,
  triggerSelection,
  type PickerOption
} from './mobile-tasks-dependencies'
import {
  LINEAR_GROUP_OPTIONS,
  LINEAR_ORDER_OPTIONS,
  LINEAR_VIEW_OPTIONS,
  PROJECT_VIEW_DEFAULT_SORT,
  SORT_OPTIONS
} from './mobile-tasks-legacy-foundation'
import { ListGroup } from '../components/ui/ListGroup'
import { ListRow } from '../components/ui/ListRow'
import { SectionHeader } from '../components/ui/SectionHeader'
import {
  MobileTasksSheetFootnote,
  MobileTasksSheetHeader,
  sheetStyles
} from './mobile-tasks-sheet-chrome'
import { renderMobileTasksIssueSourceRows } from './mobile-tasks-provider-pickers'
import { renderMobileTasksGitHubProjectFieldRows } from './mobile-tasks-filter-pickers'
import { renderMobileTasksLinearDisplayRows } from './mobile-tasks-list-display-pickers'
import { cycleMobileTasksGitHubProjectSort } from './mobile-tasks-github-project-pickers'

/** How many Filter & display settings differ from their defaults; the Filter button shows it. */
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

/** One section of single-choice rows that apply as they are tapped; the sheet stays open. */
function choiceSection<T extends string>(
  title: string,
  options: readonly PickerOption<T>[],
  selected: string,
  onSelect: (value: T) => void,
  first = false
): ReactNode {
  return (
    <>
      <SectionHeader title={title} first={first} />
      <ListGroup style={sheetStyles.group}>
        {options.map((option) => (
          <ListRow
            key={option.value}
            title={option.label}
            subtitle={option.subtitle}
            selected={option.value === selected}
            disabled={option.disabled}
            onPress={() => {
              triggerSelection()
              onSelect(option.value)
            }}
          />
        ))}
      </ListGroup>
    </>
  )
}

function renderGitHubItemsSections(model: PageChromeModel) {
  const { githubIssueSourceRows, setTaskSort, taskSort } = model
  return (
    <>
      {choiceSection('Sort by', SORT_OPTIONS, taskSort, setTaskSort, true)}
      {githubIssueSourceRows.length > 0 ? (
        <>
          <SectionHeader title="Issue source" />
          <ListGroup style={sheetStyles.group}>{renderMobileTasksIssueSourceRows(model)}</ListGroup>
          <MobileTasksSheetFootnote>
            Upstream or origin, for searching and filing issues.
          </MobileTasksSheetFootnote>
        </>
      ) : null}
    </>
  )
}

function renderGitHubProjectSections(model: PageChromeModel) {
  const {
    activeGitHubProjectView,
    githubProjectAvailableSummaryFields,
    githubProjectSortOptions,
    githubProjectSortOverride,
    githubProjectTable,
    selectedGitHubProjectViewUrl,
    setShowFilterSheet,
    setShowGitHubProjectViewPicker
  } = model
  return (
    <>
      <SectionHeader title="View" first />
      <ListGroup style={sheetStyles.group}>
        <ListRow
          key="view"
          title="Project view"
          value={activeGitHubProjectView?.name ?? 'Choose'}
          navigates
          disabled={!githubProjectTable && !activeGitHubProjectView}
          onPress={() => {
            setShowFilterSheet(false)
            setShowGitHubProjectViewPicker(true)
          }}
        />
        {selectedGitHubProjectViewUrl ? (
          <ListRow
            key="open"
            title="Open view in GitHub"
            accessibilityRole="link"
            onPress={() => Linking.openURL(selectedGitHubProjectViewUrl)}
          />
        ) : null}
      </ListGroup>
      {githubProjectTable
        ? choiceSection(
            'Sort by',
            githubProjectSortOptions,
            githubProjectSortOverride?.fieldId ?? PROJECT_VIEW_DEFAULT_SORT,
            (fieldId) => cycleMobileTasksGitHubProjectSort(model, fieldId)
          )
        : null}
      {githubProjectAvailableSummaryFields.length > 0 ? (
        <>
          <SectionHeader title="Fields on rows" />
          <ListGroup style={sheetStyles.group}>
            {renderMobileTasksGitHubProjectFieldRows(model)}
          </ListGroup>
        </>
      ) : null}
    </>
  )
}

function renderLinearSections(model: PageChromeModel) {
  const {
    linearGroupBy,
    linearOrderBy,
    linearViewMode,
    linearWorkspaceLabel,
    linearWorkspaces,
    setLinearGroupBy,
    setLinearOrderBy,
    setLinearViewMode,
    setShowFilterSheet,
    setShowLinearWorkspacePicker
  } = model
  return (
    <>
      {linearWorkspaces.length > 1 ? (
        <>
          <SectionHeader title="Workspace" first />
          <ListGroup style={sheetStyles.group}>
            <ListRow
              title="Linear workspace"
              value={linearWorkspaceLabel}
              navigates
              onPress={() => {
                setShowFilterSheet(false)
                setShowLinearWorkspacePicker(true)
              }}
            />
          </ListGroup>
        </>
      ) : null}
      {choiceSection(
        'Layout',
        LINEAR_VIEW_OPTIONS,
        linearViewMode,
        setLinearViewMode,
        linearWorkspaces.length <= 1
      )}
      {choiceSection('Group by', LINEAR_GROUP_OPTIONS, linearGroupBy, setLinearGroupBy)}
      {choiceSection('Order by', LINEAR_ORDER_OPTIONS, linearOrderBy, setLinearOrderBy)}
      <SectionHeader title="Show on rows" />
      <ListGroup style={sheetStyles.group}>{renderMobileTasksLinearDisplayRows(model)}</ListGroup>
    </>
  )
}

/** Sort, group, layout, fields and source in one sheet, so the toolbar keeps only scope chips. */
export function renderMobileTasksFilterSheet(model: PageChromeModel) {
  const {
    appliedQuery,
    githubMode,
    provider,
    setShowFilterSheet,
    setTaskSort,
    showFilterSheet,
    taskSort,
    taskUiReady
  } = model
  return (
    <BottomDrawer
      visible={taskUiReady && showFilterSheet}
      onClose={() => setShowFilterSheet(false)}
    >
      <MobileTasksSheetHeader
        title="Filter & display"
        trailing={{ label: 'Done', onPress: () => setShowFilterSheet(false) }}
        testID="mobile-tasks-filter-sheet"
      />
      {provider === 'github' && githubMode === 'project' ? (
        renderGitHubProjectSections(model)
      ) : provider === 'github' ? (
        renderGitHubItemsSections(model)
      ) : provider === 'linear' ? (
        renderLinearSections(model)
      ) : (
        <>
          {choiceSection('Sort by', SORT_OPTIONS, taskSort, setTaskSort, true)}
          {provider === 'jira' && appliedQuery.trim().length > 0 ? (
            <MobileTasksSheetFootnote>
              Your JQL search replaces the Show preset. Clear the search to pick one again.
            </MobileTasksSheetFootnote>
          ) : null}
        </>
      )}
    </BottomDrawer>
  )
}
