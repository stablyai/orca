import type { ConnectionPresentationModel } from './use-mobile-tasks-connection-presentation'
import {
  BottomDrawer,
  View,
  Text,
  Pressable,
  Check,
  colors,
  PickerModal,
  ActivityIndicator
} from './mobile-tasks-dependencies'
import { styles } from './mobile-tasks-legacy-styles'
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
        <Text style={styles.sheetTitle}>Project Fields</Text>
        <Text style={styles.sheetSubtitle}>Choose which Project fields appear on item cards.</Text>
      </View>
      <View style={styles.repoPickerGroup}>
        {githubProjectAvailableSummaryFields.length === 0 ? (
          <Text style={styles.repoPickerSubtitle}>This view has no extra fields to show.</Text>
        ) : (
          githubProjectAvailableSummaryFields.map((field, index) => {
            const visible = !githubProjectHiddenFieldIds.has(field.id)
            return (
              <View key={field.id}>
                {index > 0 ? <View style={styles.actionSeparator} /> : null}
                <Pressable
                  style={styles.repoPickerRow}
                  onPress={() => toggleGitHubProjectFieldVisibility(field.id)}
                >
                  <View style={styles.repoPickerTextWrap}>
                    <Text style={styles.repoPickerTitle} numberOfLines={1}>
                      {field.name}
                    </Text>
                    <Text style={styles.repoPickerSubtitle} numberOfLines={1}>
                      {visible ? 'Shown on cards' : 'Hidden from cards'}
                    </Text>
                  </View>
                  {visible ? <Check size={15} color={colors.textPrimary} /> : null}
                </Pressable>
              </View>
            )
          })
        )}
      </View>
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
      title="GitLab View"
      options={GITLAB_VIEW_OPTIONS}
      selected={gitlabView}
      onSelect={(view) => {
        setGitlabView(view)
        if (view === 'todos') {
          // Why: GitLab Todos is a server-side pending-todos stream; the
          // runtime method has no search query, so clear item-search state
          // when entering that view instead of carrying an invisible filter.
          setQuery('')
          setAppliedQuery('')
        }
      }}
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
      title="GitLab Filter"
      options={GITLAB_FILTER_OPTIONS}
      selected={gitlabFilter}
      onSelect={setGitlabFilter}
      onClose={() => setShowGitLabFilterPicker(false)}
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
      title="Linear Filter"
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
      title="Linear Workspace"
      options={linearWorkspaceOptions}
      selected={selectedLinearWorkspaceId ?? ''}
      onSelect={(workspaceId) => {
        setSelectedLinearWorkspaceId(workspaceId)
        setSelectedLinearTeamIds(new Set())
        if (client) {
          void client
            .sendRequest('linear.selectWorkspace', { workspaceId })
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
      <View style={styles.sheetHeader}>
        <Text style={styles.sheetTitle}>Linear Teams</Text>
        <Text style={styles.sheetSubtitle}>Choose which teams appear in Tasks.</Text>
      </View>
      <View style={styles.repoPickerGroup}>
        <Pressable
          style={styles.repoPickerRow}
          onPress={() => {
            const next = new Set(linearTeams.map((team) => team.id))
            setSelectedLinearTeamIds(next)
            persistLinearTeamSelection(next, linearTeams)
          }}
        >
          <View style={styles.repoPickerTextWrap}>
            <Text style={styles.repoPickerTitle}>All teams</Text>
            <Text style={styles.repoPickerSubtitle}>{linearTeams.length} teams</Text>
          </View>
          {selectedLinearTeamIds.size === linearTeams.length ? (
            <Check size={15} color={colors.textPrimary} />
          ) : null}
        </Pressable>
        {linearTeams.map((team) => {
          const selected = selectedLinearTeamIds.has(team.id)
          return (
            <View key={team.id}>
              <View style={styles.actionSeparator} />
              <Pressable
                style={styles.repoPickerRow}
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
              >
                <View style={styles.repoPickerTextWrap}>
                  <Text style={styles.repoPickerTitle} numberOfLines={1}>
                    {team.name}
                  </Text>
                  <Text style={styles.repoPickerSubtitle} numberOfLines={1}>
                    {team.workspaceName ?? team.key}
                  </Text>
                </View>
                {selected ? <Check size={15} color={colors.textPrimary} /> : null}
              </Pressable>
            </View>
          )
        })}
      </View>
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
        <Text style={styles.sheetTitle}>Change Status</Text>
        <Text style={styles.sheetSubtitle}>
          {linearStatusPickerItem?.source.identifier ?? 'Linear issue'}
        </Text>
      </View>
      <View style={styles.repoPickerGroup}>
        {linearStatesLoading ? (
          <View style={styles.detailLoadingInline}>
            <ActivityIndicator size="small" color={colors.textSecondary} />
            <Text style={styles.detailMuted}>Loading states...</Text>
          </View>
        ) : linearStates.length === 0 ? (
          <Text style={styles.emptyInlineText}>No states available</Text>
        ) : (
          linearStates.map((state, index) => {
            const selected =
              state.name === linearStatusPickerItem?.source.state.name &&
              state.type === linearStatusPickerItem?.source.state.type
            return (
              <View key={state.id}>
                {index > 0 ? <View style={styles.actionSeparator} /> : null}
                <Pressable
                  style={styles.repoPickerRow}
                  disabled={mutatingStatus}
                  onPress={() => {
                    if (!linearStatusPickerItem) {
                      return
                    }
                    void setLinearStatus(linearStatusPickerItem, state, {
                      closeDetail: false
                    }).then(() => setLinearStatusPickerItem(null))
                  }}
                >
                  <View
                    style={[
                      styles.pickerRepoDot,
                      { backgroundColor: state.color || colors.textMuted }
                    ]}
                  />
                  <View style={styles.repoPickerTextWrap}>
                    <Text style={styles.repoPickerTitle} numberOfLines={1}>
                      {state.name}
                    </Text>
                    <Text style={styles.repoPickerSubtitle} numberOfLines={1}>
                      {state.type}
                    </Text>
                  </View>
                  {selected ? <Check size={15} color={colors.textPrimary} /> : null}
                </Pressable>
              </View>
            )
          })
        )}
      </View>
    </BottomDrawer>
  )
}
