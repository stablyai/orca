import type { ConnectionPresentationModel } from './use-mobile-tasks-connection-presentation'
import { translate } from '../i18n/mobile-i18n'
import {
  BottomDrawer,
  View,
  Text,
  colors,
  PickerModal,
  ActivityIndicator
} from './mobile-tasks-dependencies'
import { ListGroup } from '../components/list/ListGroup'
import { ListRow } from '../components/list/ListRow'
import { linearWorkspaceSelect } from './mobile-task-runtime-operations'
import { styles } from './mobile-tasks-legacy-styles'
import { JIRA_FILTER_OPTIONS } from './mobile-task-view-options'
import {
  GITLAB_VIEW_OPTIONS,
  GITLAB_FILTER_OPTIONS,
  LINEAR_FILTER_OPTIONS,
  TASK_SECONDARY_DRAWER_Z_INDEX
} from './mobile-tasks-legacy-foundation'

export function renderMobileTasksGitHubProjectFieldsPicker(model: ConnectionPresentationModel) {
  const {
    githubProjectAvailableSummaryFields,
    githubProjectHiddenFieldIds,
    setShowGitHubProjectFieldsPicker,
    showGitHubProjectFieldsPicker,
    taskUiReady,
    toggleGitHubProjectFieldVisibility
  } = model
  return (
    <BottomDrawer
      visible={taskUiReady && showGitHubProjectFieldsPicker}
      onClose={() => setShowGitHubProjectFieldsPicker(false)}
    >
      <View style={styles.sheetHeader}>
        <Text style={styles.sheetTitle}>
          {translate('tasks.filterPickers.fieldsTitle', 'Project Fields')}
        </Text>
        <Text style={styles.sheetSubtitle}>
          {translate(
            'tasks.filterPickers.fieldsSubtitle',
            'Choose which Project fields appear on item cards.'
          )}
        </Text>
      </View>
      {githubProjectAvailableSummaryFields.length === 0 ? (
        <Text style={styles.repoPickerSubtitle}>
          {translate('tasks.filterPickers.noFields', 'This view has no extra fields to show.')}
        </Text>
      ) : (
        <ListGroup>
          {githubProjectAvailableSummaryFields.map((field) => {
            const visible = !githubProjectHiddenFieldIds.has(field.id)
            return (
              <ListRow
                key={field.id}
                title={field.name}
                subtitle={
                  visible
                    ? translate('tasks.filterPickers.fieldShown', 'Shown on cards')
                    : translate('tasks.filterPickers.fieldHidden', 'Hidden from cards')
                }
                selected={visible}
                accessibilityRole="checkbox"
                onPress={() => toggleGitHubProjectFieldVisibility(field.id)}
              />
            )
          })}
        </ListGroup>
      )}
    </BottomDrawer>
  )
}

export function renderMobileTasksGitLabViewPicker(model: ConnectionPresentationModel) {
  const {
    gitlabView,
    setAppliedQuery,
    setGitlabView,
    setQuery,
    setShowGitLabViewPicker,
    showGitLabViewPicker,
    taskUiReady
  } = model
  return (
    <PickerModal
      visible={taskUiReady && showGitLabViewPicker}
      title={translate('tasks.filterPickers.gitlabView', 'GitLab View')}
      options={GITLAB_VIEW_OPTIONS}
      selected={gitlabView}
      onSelect={(view) => {
        setGitlabView(view)
        if (view === 'todos') {
          // GitLab Todos has no server search query; clear item filters instead of carrying an invisible one.
          setQuery('')
          setAppliedQuery('')
        }
      }}
      onClose={() => setShowGitLabViewPicker(false)}
    />
  )
}

export function renderMobileTasksGitLabFilterPicker(model: ConnectionPresentationModel) {
  return (
    <PickerModal
      visible={model.taskUiReady && model.showGitLabFilterPicker}
      title={translate('tasks.filterPickers.gitlabFilter', 'GitLab Filter')}
      options={GITLAB_FILTER_OPTIONS}
      selected={model.gitlabFilter}
      onSelect={model.setGitlabFilter}
      onClose={() => model.setShowGitLabFilterPicker(false)}
    />
  )
}

export function renderMobileTasksLinearFilterPicker(model: ConnectionPresentationModel) {
  const {
    linearFilter,
    persistTaskResumeState,
    setAppliedQuery,
    setLinearFilter,
    setQuery,
    setShowLinearFilterPicker,
    showLinearFilterPicker,
    taskUiReady
  } = model
  return (
    <PickerModal
      visible={taskUiReady && showLinearFilterPicker}
      title={translate('tasks.filterPickers.linearFilter', 'Linear Filter')}
      options={LINEAR_FILTER_OPTIONS}
      selected={linearFilter}
      onSelect={(filter) => {
        setLinearFilter(filter)
        setQuery('')
        setAppliedQuery('')
        persistTaskResumeState({ linearPreset: filter, linearQuery: '' })
      }}
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
      title={translate('tasks.filterPickers.linearWorkspace', 'Linear Workspace')}
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
              setError(
                err instanceof Error
                  ? err.message
                  : translate(
                      'tasks.filterPickers.switchWorkspaceFailed',
                      'Failed to switch workspace'
                    )
              )
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
  const count = linearTeams.length
  return (
    <BottomDrawer
      visible={taskUiReady && showLinearTeamPicker}
      onClose={() => setShowLinearTeamPicker(false)}
    >
      <View style={styles.sheetHeader}>
        <Text style={styles.sheetTitle}>
          {translate('tasks.filterPickers.teamsTitle', 'Linear Teams')}
        </Text>
        <Text style={styles.sheetSubtitle}>
          {translate('tasks.filterPickers.teamsSubtitle', 'Choose which teams appear in Tasks.')}
        </Text>
      </View>
      <ListGroup>
        <ListRow
          key="all"
          title={translate('tasks.filterPickers.allTeams', 'All teams')}
          subtitle={
            count === 1
              ? translate('tasks.filterPickers.teams_one', '{{count}} team', { count })
              : translate('tasks.filterPickers.teams_other', '{{count}} teams', { count })
          }
          selected={selectedLinearTeamIds.size === linearTeams.length}
          accessibilityRole="checkbox"
          onPress={() => {
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
            accessibilityRole="checkbox"
            onPress={() => {
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
      <View style={styles.sheetHeader}>
        <Text style={styles.sheetTitle}>
          {translate('tasks.filterPickers.changeStatus', 'Change Status')}
        </Text>
        <Text style={styles.sheetSubtitle}>
          {linearStatusPickerItem?.source.identifier ??
            translate('tasks.filterPickers.linearIssue', 'Linear issue')}
        </Text>
      </View>
      <ListGroup>
        {linearStatesLoading ? (
          <View style={styles.detailLoadingInline}>
            <ActivityIndicator size="small" color={colors.textSecondary} />
            <Text style={styles.detailMuted}>
              {translate('tasks.filterPickers.loadingStates', 'Loading states...')}
            </Text>
          </View>
        ) : linearStates.length === 0 ? (
          <Text style={styles.emptyInlineText}>
            {translate('tasks.filterPickers.noStates', 'No states available')}
          </Text>
        ) : (
          linearStates.map((state) => (
            <ListRow
              key={state.id}
              title={state.name}
              subtitle={state.type}
              leading={
                <View
                  style={[
                    styles.pickerRepoDot,
                    { backgroundColor: state.color || colors.textMuted }
                  ]}
                />
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
                void setLinearStatus(linearStatusPickerItem, state, {
                  closeDetail: false
                }).then(() => setLinearStatusPickerItem(null))
              }}
            />
          ))
        )}
      </ListGroup>
    </BottomDrawer>
  )
}

export function renderMobileTasksJiraFilterPicker(model: ConnectionPresentationModel) {
  const {
    jiraFilter,
    persistTaskResumeState,
    setAppliedQuery,
    setJiraFilter,
    setQuery,
    setShowJiraFilterPicker,
    showJiraFilterPicker,
    taskUiReady
  } = model
  return (
    <PickerModal
      visible={taskUiReady && showJiraFilterPicker}
      title={translate('tasks.filterPickers.jiraFilter', 'Jira Filter')}
      options={JIRA_FILTER_OPTIONS}
      selected={jiraFilter}
      onSelect={(filter) => {
        setJiraFilter(filter)
        setQuery('')
        setAppliedQuery('')
        persistTaskResumeState({ jiraPreset: filter, jiraQuery: '' })
      }}
      onClose={() => setShowJiraFilterPicker(false)}
    />
  )
}

export function renderMobileTasksJiraSitePicker(model: ConnectionPresentationModel) {
  return (
    <PickerModal
      visible={model.taskUiReady && model.showJiraSitePicker}
      title={translate('tasks.filterPickers.jiraSite', 'Jira Site')}
      options={model.jiraSiteOptions}
      selected={model.jiraConnection.selection ?? ''}
      onSelect={(siteId) => {
        model.setJiraConnection((current) => ({ ...current, selection: siteId }))
        model.setItems([])
      }}
      onClose={() => model.setShowJiraSitePicker(false)}
    />
  )
}
