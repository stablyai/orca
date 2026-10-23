import type { ConnectionPresentationModel } from './use-mobile-tasks-connection-presentation'
import { BottomDrawer, View, PickerModal, triggerSelection } from './mobile-tasks-dependencies'
import { linearWorkspaceSelect } from './mobile-task-runtime-operations'
import { JIRA_FILTER_OPTIONS } from './mobile-task-view-options'
import {
  GITLAB_VIEW_OPTIONS,
  GITLAB_FILTER_OPTIONS,
  LINEAR_FILTER_OPTIONS,
  TASK_SECONDARY_DRAWER_Z_INDEX,
  type GitLabView,
  type LinearFilter
} from './mobile-tasks-legacy-foundation'
import type { JiraIssueFilter } from '../../../src/shared/jira-types'
import { ListGroup, LIST_LEADING_INSET } from '../components/ui/ListGroup'
import { ListRow } from '../components/ui/ListRow'
import { StateView } from '../components/ui/StateView'
import { PickerEmptyState, PickerSheetTitle } from '../components/PickerModal'
import {
  MobileTasksSheetFootnote,
  MobileTasksSheetHeader,
  sheetStyles
} from './mobile-tasks-sheet-chrome'

/** Shows or hides one Project field on the rows; the list keeps at least what the view sets. */
export function renderMobileTasksGitHubProjectFieldRows(model: ConnectionPresentationModel) {
  const {
    githubProjectAvailableSummaryFields,
    githubProjectHiddenFieldIds,
    toggleGitHubProjectFieldVisibility
  } = model
  return githubProjectAvailableSummaryFields.map((field) => (
    <ListRow
      key={field.id}
      title={field.name}
      selected={!githubProjectHiddenFieldIds.has(field.id)}
      accessibilityRole="button"
      onPress={() => {
        triggerSelection()
        toggleGitHubProjectFieldVisibility(field.id)
      }}
    />
  ))
}

export function renderMobileTasksGitHubProjectFieldsPicker(model: ConnectionPresentationModel) {
  const {
    githubProjectAvailableSummaryFields,
    setShowGitHubProjectFieldsPicker,
    showGitHubProjectFieldsPicker,
    taskUiReady
  } = model
  return (
    <BottomDrawer
      visible={taskUiReady && showGitHubProjectFieldsPicker}
      onClose={() => setShowGitHubProjectFieldsPicker(false)}
    >
      <MobileTasksSheetHeader
        title="Project fields"
        trailing={{
          label: 'Done',
          onPress: () => setShowGitHubProjectFieldsPicker(false)
        }}
      />
      {githubProjectAvailableSummaryFields.length === 0 ? (
        <PickerEmptyState message="This view has no extra fields to show." />
      ) : (
        <>
          <ListGroup style={sheetStyles.group}>
            {renderMobileTasksGitHubProjectFieldRows(model)}
          </ListGroup>
          <MobileTasksSheetFootnote>Checked fields show on each row.</MobileTasksSheetFootnote>
        </>
      )}
    </BottomDrawer>
  )
}

export function selectMobileTasksGitLabView(model: ConnectionPresentationModel, view: GitLabView) {
  const { setAppliedQuery, setGitlabView, setQuery } = model
  setGitlabView(view)
  if (view === 'todos') {
    // Why: GitLab Todos is a server-side pending-todos stream; the
    // runtime method has no search query, so clear item-search state
    // when entering that view instead of carrying an invisible filter.
    setQuery('')
    setAppliedQuery('')
  }
}

export function renderMobileTasksGitLabViewPicker(model: ConnectionPresentationModel) {
  const { gitlabView, setShowGitLabViewPicker, showGitLabViewPicker, taskUiReady } = model
  return (
    <PickerModal
      visible={taskUiReady && showGitLabViewPicker}
      title="GitLab view"
      options={GITLAB_VIEW_OPTIONS}
      selected={gitlabView}
      onSelect={(view) => selectMobileTasksGitLabView(model, view)}
      onClose={() => setShowGitLabViewPicker(false)}
    />
  )
}

export function renderMobileTasksGitLabFilterPicker(model: ConnectionPresentationModel) {
  const {
    gitlabFilter,
    setGitlabFilter,
    setShowGitLabFilterPicker,
    showGitLabFilterPicker,
    taskUiReady
  } = model
  return (
    <PickerModal
      visible={taskUiReady && showGitLabFilterPicker}
      title="Show"
      options={GITLAB_FILTER_OPTIONS}
      selected={gitlabFilter}
      onSelect={setGitlabFilter}
      onClose={() => setShowGitLabFilterPicker(false)}
    />
  )
}

export function selectMobileTasksLinearFilter(
  model: ConnectionPresentationModel,
  filter: LinearFilter
) {
  const { persistTaskResumeState, setAppliedQuery, setLinearFilter, setQuery } = model
  setLinearFilter(filter)
  setQuery('')
  setAppliedQuery('')
  persistTaskResumeState({ linearPreset: filter, linearQuery: '' })
}

export function renderMobileTasksLinearFilterPicker(model: ConnectionPresentationModel) {
  const { linearFilter, setShowLinearFilterPicker, showLinearFilterPicker, taskUiReady } = model
  return (
    <PickerModal
      visible={taskUiReady && showLinearFilterPicker}
      title="Show"
      options={LINEAR_FILTER_OPTIONS}
      selected={linearFilter}
      onSelect={(filter) => selectMobileTasksLinearFilter(model, filter)}
      onClose={() => setShowLinearFilterPicker(false)}
    />
  )
}

export function renderMobileTasksLinearWorkspacePicker(model: ConnectionPresentationModel) {
  const {
    client,
    linearWorkspaceOptions,
    loadLinearContext,
    selectedLinearWorkspaceId,
    setError,
    setSelectedLinearTeamIds,
    setSelectedLinearWorkspaceId,
    setShowLinearWorkspacePicker,
    showLinearWorkspacePicker,
    taskUiReady
  } = model
  return (
    <PickerModal
      visible={taskUiReady && showLinearWorkspacePicker}
      title="Linear workspace"
      options={linearWorkspaceOptions}
      selected={selectedLinearWorkspaceId ?? ''}
      onSelect={(workspaceId) => {
        setSelectedLinearWorkspaceId(workspaceId)
        setSelectedLinearTeamIds(new Set())
        if (client) {
          void linearWorkspaceSelect
            .request(client, { workspaceId })
            .then(() => loadLinearContext())
            .catch((err) => {
              setError(err instanceof Error ? err.message : 'Failed to switch workspace')
            })
        }
      }}
      onClose={() => setShowLinearWorkspacePicker(false)}
    />
  )
}

export function renderMobileTasksLinearTeamPicker(model: ConnectionPresentationModel) {
  const {
    linearTeams,
    persistLinearTeamSelection,
    selectedLinearTeamIds,
    setSelectedLinearTeamIds,
    setShowLinearTeamPicker,
    showLinearTeamPicker,
    taskUiReady
  } = model
  return (
    <BottomDrawer
      visible={taskUiReady && showLinearTeamPicker}
      onClose={() => setShowLinearTeamPicker(false)}
    >
      <MobileTasksSheetHeader
        title="Teams"
        subtitle="Choose which teams appear in Tasks."
        trailing={{
          label: 'Done',
          onPress: () => setShowLinearTeamPicker(false)
        }}
      />
      <ListGroup style={sheetStyles.group}>
        <ListRow
          key="all"
          title="All teams"
          subtitle={`${linearTeams.length} ${linearTeams.length === 1 ? 'team' : 'teams'}`}
          selected={selectedLinearTeamIds.size === linearTeams.length}
          accessibilityRole="button"
          onPress={() => {
            triggerSelection()
            const next = new Set(linearTeams.map((team) => team.id))
            setSelectedLinearTeamIds(next)
            persistLinearTeamSelection(next, linearTeams)
          }}
        />
        {linearTeams.map((team) => (
          <ListRow
            key={team.id}
            title={team.name}
            subtitle={team.workspaceName ?? team.key}
            selected={selectedLinearTeamIds.has(team.id)}
            accessibilityRole="button"
            onPress={() => {
              triggerSelection()
              const next = new Set(selectedLinearTeamIds)
              if (next.has(team.id)) {
                next.delete(team.id)
              } else {
                next.add(team.id)
              }
              const normalized =
                next.size === 0 || next.size === linearTeams.length
                  ? new Set(linearTeams.map((entry) => entry.id))
                  : next
              setSelectedLinearTeamIds(normalized)
              persistLinearTeamSelection(normalized, linearTeams)
            }}
          />
        ))}
      </ListGroup>
    </BottomDrawer>
  )
}

// Linear's workflow types, in the words its own app uses.
const LINEAR_STATE_TYPE_LABELS: Record<string, string> = {
  triage: 'Triage',
  backlog: 'Backlog',
  unstarted: 'Not started',
  started: 'In progress',
  completed: 'Done',
  canceled: 'Canceled'
}

export function renderMobileTasksLinearStatusPicker(model: ConnectionPresentationModel) {
  const {
    linearStates,
    linearStatesLoading,
    linearStatusPickerItem,
    mutatingStatus,
    setLinearStatus,
    setLinearStatusPickerItem,
    taskUiReady
  } = model
  return (
    <BottomDrawer
      visible={taskUiReady && linearStatusPickerItem !== null}
      onClose={() => setLinearStatusPickerItem(null)}
      zIndex={TASK_SECONDARY_DRAWER_Z_INDEX}
    >
      <PickerSheetTitle
        title="Change status"
        subtitle={linearStatusPickerItem?.source.identifier ?? 'Linear issue'}
      />
      {linearStatesLoading ? (
        <View style={sheetStyles.loading}>
          <StateView loading title="Loading statuses…" />
        </View>
      ) : linearStates.length === 0 ? (
        <PickerEmptyState message="This team has no statuses to choose from." />
      ) : (
        <ListGroup separatorInset={LIST_LEADING_INSET} style={sheetStyles.group}>
          {linearStates.map((state) => (
            <ListRow
              key={state.id}
              title={state.name}
              subtitle={LINEAR_STATE_TYPE_LABELS[state.type]}
              leading={
                <View style={[sheetStyles.dot, { backgroundColor: state.color || undefined }]} />
              }
              selected={
                state.name === linearStatusPickerItem?.source.state.name &&
                state.type === linearStatusPickerItem?.source.state.type
              }
              disabled={mutatingStatus}
              onPress={() => {
                if (!linearStatusPickerItem) {
                  return
                }
                triggerSelection()
                void setLinearStatus(linearStatusPickerItem, state, {
                  closeDetail: false
                }).then(() => setLinearStatusPickerItem(null))
              }}
            />
          ))}
        </ListGroup>
      )}
    </BottomDrawer>
  )
}

export function selectMobileTasksJiraFilter(
  model: ConnectionPresentationModel,
  filter: JiraIssueFilter
) {
  const { persistTaskResumeState, setAppliedQuery, setJiraFilter, setQuery } = model
  setJiraFilter(filter)
  setQuery('')
  setAppliedQuery('')
  persistTaskResumeState({ jiraPreset: filter, jiraQuery: '' })
}

export function renderMobileTasksJiraFilterPicker(model: ConnectionPresentationModel) {
  const { jiraFilter, setShowJiraFilterPicker, showJiraFilterPicker, taskUiReady } = model
  return (
    <PickerModal
      visible={taskUiReady && showJiraFilterPicker}
      title="Show"
      options={JIRA_FILTER_OPTIONS}
      selected={jiraFilter}
      onSelect={(filter) => selectMobileTasksJiraFilter(model, filter)}
      onClose={() => setShowJiraFilterPicker(false)}
    />
  )
}

export function renderMobileTasksJiraSitePicker(model: ConnectionPresentationModel) {
  const {
    jiraConnection,
    jiraSiteOptions,
    setItems,
    setJiraConnection,
    setShowJiraSitePicker,
    showJiraSitePicker,
    taskUiReady
  } = model
  return (
    <PickerModal
      visible={taskUiReady && showJiraSitePicker}
      title="Jira site"
      options={jiraSiteOptions}
      selected={jiraConnection.selection ?? ''}
      onSelect={(siteId) => {
        setJiraConnection((current) => ({ ...current, selection: siteId }))
        setItems([])
      }}
      onClose={() => setShowJiraSitePicker(false)}
    />
  )
}
