import type { ConnectionPresentationModel } from './use-mobile-tasks-connection-presentation'
import {
  BottomDrawer,
  View,
  Text,
  TextInput,
  colors,
  Pressable,
  AlertTriangle,
  ActivityIndicator,
  githubProjectKey,
  Check,
  PickerModal
} from './mobile-tasks-dependencies'
import { styles } from './mobile-tasks-legacy-styles'
import { PROJECT_VIEW_DEFAULT_SORT } from './mobile-tasks-legacy-foundation'

export function renderMobileTasksGitHubProjectPicker(model: ConnectionPresentationModel) {
  const {
    activeGitHubProject,
    browseGitHubProjects,
    githubProjectError,
    githubProjectLoading,
    githubProjectPartialFailures,
    githubProjectPasteBusy,
    githubProjectPasteError,
    githubProjectPasteInput,
    githubProjectPickerSearch,
    githubProjectSettings,
    githubProjects,
    loadGitHubProjects,
    persistGitHubProjectSettings,
    pinnedGitHubProjects,
    recentGitHubProjects,
    resolveGitHubProjectFromInput,
    selectGitHubProject,
    setGithubProjectError,
    setGithubProjectPasteError,
    setGithubProjectPasteInput,
    setGithubProjectPickerSearch,
    setShowGitHubProjectPicker,
    showGitHubProjectPicker,
    taskUiReady
  } = model
  return (
    <BottomDrawer
      visible={taskUiReady && showGitHubProjectPicker}
      onClose={() => setShowGitHubProjectPicker(false)}
    >
      <View style={styles.sheetHeader}>
        <Text style={styles.sheetTitle}>GitHub Projects</Text>
        <Text style={styles.sheetSubtitle}>Choose a project view for the Tasks page.</Text>
      </View>

      <View style={styles.projectPickerControls}>
        <TextInput
          style={styles.input}
          value={githubProjectPickerSearch}
          onChangeText={setGithubProjectPickerSearch}
          placeholder="Search projects"
          placeholderTextColor={colors.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <View style={styles.projectPasteRow}>
          <TextInput
            style={[styles.input, styles.projectPasteInput]}
            value={githubProjectPasteInput}
            onChangeText={(next) => {
              setGithubProjectPasteInput(next)
              setGithubProjectPasteError('')
            }}
            onSubmitEditing={() => void resolveGitHubProjectFromInput()}
            placeholder="Add by URL or owner/number"
            placeholderTextColor={colors.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Pressable
            style={[styles.inlineSaveButtonCompact, styles.projectPasteButton]}
            disabled={githubProjectPasteBusy || githubProjectPasteInput.trim().length === 0}
            onPress={() => void resolveGitHubProjectFromInput()}
          >
            <Text style={styles.inlineSaveText}>
              {githubProjectPasteBusy ? 'Adding...' : 'Add'}
            </Text>
          </Pressable>
        </View>
        {githubProjectPasteError ? (
          <Text style={styles.detailError}>{githubProjectPasteError}</Text>
        ) : null}
      </View>

      {githubProjectError ? <Text style={styles.detailError}>{githubProjectError}</Text> : null}

      {githubProjectPartialFailures.length > 0 ? (
        <View style={styles.projectWarningBanner}>
          <AlertTriangle size={15} color={colors.statusAmber} />
          <View style={styles.projectWarningTextWrap}>
            <Text style={styles.projectWarningTitle}>
              {githubProjectPartialFailures.length === 1 &&
              githubProjectPartialFailures[0]!.owner !== '*'
                ? `Couldn't load projects from ${githubProjectPartialFailures[0]!.owner}.`
                : `Some organizations didn't load (${githubProjectPartialFailures.length}).`}
            </Text>
            <Text style={styles.projectWarningText}>Use Add by URL to reach missing projects.</Text>
            <Text style={styles.projectWarningText} numberOfLines={2}>
              {githubProjectPartialFailures
                .map(
                  (failure) =>
                    `${failure.owner === '*' ? 'orgs' : failure.owner}: ${failure.message}`
                )
                .join(' · ')}
            </Text>
          </View>
        </View>
      ) : null}

      <View style={styles.repoPickerGroup}>
        {githubProjectLoading && githubProjects.length === 0 ? (
          <View style={styles.drawerLoadingRow}>
            <ActivityIndicator size="small" color={colors.textSecondary} />
          </View>
        ) : githubProjects.length === 0 &&
          pinnedGitHubProjects.length === 0 &&
          recentGitHubProjects.length === 0 ? (
          <Pressable
            style={styles.repoPickerRow}
            onPress={() =>
              void loadGitHubProjects().catch((err) => {
                setGithubProjectError(
                  err instanceof Error ? err.message : 'Failed to load projects'
                )
              })
            }
          >
            <View style={styles.repoPickerTextWrap}>
              <Text style={styles.repoPickerTitle}>No projects loaded</Text>
              <Text style={styles.repoPickerSubtitle}>Tap to retry.</Text>
            </View>
          </Pressable>
        ) : (
          <>
            {pinnedGitHubProjects.length > 0 ? (
              <>
                <Text style={styles.linearStatesTitle}>Pinned</Text>
                {pinnedGitHubProjects.map((project, index) => {
                  const key = githubProjectKey(project)
                  const selected =
                    activeGitHubProject !== null && githubProjectKey(activeGitHubProject) === key
                  return (
                    <View key={`pinned:${key}`}>
                      {index > 0 ? <View style={styles.actionSeparator} /> : null}
                      <Pressable
                        style={styles.repoPickerRow}
                        onPress={() => {
                          setShowGitHubProjectPicker(false)
                          void selectGitHubProject(project)
                        }}
                      >
                        <View style={styles.repoPickerTextWrap}>
                          <Text style={styles.repoPickerTitle} numberOfLines={1}>
                            {project.summary?.title ?? `#${project.number}`}
                          </Text>
                          <Text style={styles.repoPickerSubtitle} numberOfLines={1}>
                            {project.owner} · #{project.number}
                          </Text>
                        </View>
                        <Pressable
                          style={styles.inlineSaveButtonCompact}
                          onPress={(event) => {
                            event.stopPropagation()
                            persistGitHubProjectSettings({
                              ...githubProjectSettings,
                              pinned: githubProjectSettings.pinned.filter(
                                (entry) => githubProjectKey(entry) !== key
                              )
                            })
                          }}
                        >
                          <Text style={styles.inlineSaveText}>Remove</Text>
                        </Pressable>
                        {selected ? <Check size={15} color={colors.textPrimary} /> : null}
                      </Pressable>
                    </View>
                  )
                })}
              </>
            ) : null}

            {recentGitHubProjects.length > 0 ? (
              <>
                <Text style={styles.linearStatesTitle}>Recent</Text>
                {recentGitHubProjects.map((project, index) => {
                  const key = githubProjectKey(project)
                  const selected =
                    activeGitHubProject !== null && githubProjectKey(activeGitHubProject) === key
                  return (
                    <View key={`recent:${key}`}>
                      {index > 0 ? <View style={styles.actionSeparator} /> : null}
                      <Pressable
                        style={styles.repoPickerRow}
                        onPress={() => {
                          setShowGitHubProjectPicker(false)
                          void selectGitHubProject(project)
                        }}
                      >
                        <View style={styles.repoPickerTextWrap}>
                          <Text style={styles.repoPickerTitle} numberOfLines={1}>
                            {project.summary?.title ?? `#${project.number}`}
                          </Text>
                          <Text style={styles.repoPickerSubtitle} numberOfLines={1}>
                            {project.owner} · #{project.number}
                          </Text>
                        </View>
                        {githubProjectSettings.lastViewByProject[key]?.viewId ? (
                          <Pressable
                            style={styles.inlineSaveButtonCompact}
                            onPress={(event) => {
                              event.stopPropagation()
                              persistGitHubProjectSettings({
                                ...githubProjectSettings,
                                pinned: [
                                  ...githubProjectSettings.pinned,
                                  {
                                    owner: project.owner,
                                    ownerType: project.ownerType,
                                    number: project.number
                                  }
                                ].slice(0, 20)
                              })
                            }}
                          >
                            <Text style={styles.inlineSaveText}>Pin</Text>
                          </Pressable>
                        ) : null}
                        {selected ? <Check size={15} color={colors.textPrimary} /> : null}
                      </Pressable>
                    </View>
                  )
                })}
              </>
            ) : null}

            <Text style={styles.linearStatesTitle}>
              {githubProjectLoading ? 'Browse all (loading...)' : 'Browse all'}
            </Text>
            {browseGitHubProjects.length === 0 ? (
              <Text style={styles.emptyInlineText}>
                {githubProjectPickerSearch.trim() ? 'No matching projects.' : 'No more projects.'}
              </Text>
            ) : (
              browseGitHubProjects.map((project, index) => {
                const selected =
                  activeGitHubProject !== null &&
                  githubProjectKey(activeGitHubProject) === githubProjectKey(project)
                return (
                  <View key={project.id}>
                    {index > 0 ? <View style={styles.actionSeparator} /> : null}
                    <Pressable
                      style={styles.repoPickerRow}
                      onPress={() => {
                        setShowGitHubProjectPicker(false)
                        void selectGitHubProject(project)
                      }}
                    >
                      <View style={styles.repoPickerTextWrap}>
                        <Text style={styles.repoPickerTitle} numberOfLines={1}>
                          {project.title}
                        </Text>
                        <Text style={styles.repoPickerSubtitle} numberOfLines={1}>
                          {project.owner} · #{project.number}
                        </Text>
                      </View>
                      {selected ? <Check size={15} color={colors.textPrimary} /> : null}
                    </Pressable>
                  </View>
                )
              })
            )}
          </>
        )}
      </View>
    </BottomDrawer>
  )
}

export function renderMobileTasksGitHubProjectViewPicker(model: ConnectionPresentationModel) {
  const {
    activeGitHubProject,
    activeGitHubProjectKey,
    activeGitHubProjectViewId,
    commitGitHubProjectView,
    githubProjectViewOptions,
    githubProjectViews,
    pendingGitHubProjectViewSelection,
    setGithubProjectError,
    setPendingGitHubProjectViewSelection,
    setShowGitHubProjectViewPicker,
    showGitHubProjectViewPicker,
    taskUiReady
  } = model
  return (
    <PickerModal
      visible={taskUiReady && showGitHubProjectViewPicker}
      title={pendingGitHubProjectViewSelection ? 'Choose Project View' : 'Project View'}
      options={githubProjectViewOptions}
      selected={pendingGitHubProjectViewSelection ? '' : (activeGitHubProjectViewId ?? '')}
      onSelect={(viewId) => {
        const view = githubProjectViews.find((candidate) => candidate.id === viewId)
        if (view && view.layout !== 'TABLE_LAYOUT') {
          setGithubProjectError("Orca doesn't support this GitHub Project layout yet.")
          return
        }
        if (pendingGitHubProjectViewSelection) {
          commitGitHubProjectView(pendingGitHubProjectViewSelection, viewId)
          setPendingGitHubProjectViewSelection(null)
          return
        }
        if (!activeGitHubProject || !activeGitHubProjectKey) {
          return
        }
        commitGitHubProjectView(activeGitHubProject, viewId)
      }}
      onClose={() => {
        setShowGitHubProjectViewPicker(false)
        if (pendingGitHubProjectViewSelection) {
          setPendingGitHubProjectViewSelection(null)
        }
      }}
    />
  )
}

export function renderMobileTasksGitHubProjectSortPicker(model: ConnectionPresentationModel) {
  const {
    githubProjectSortOptions,
    githubProjectSortOverride,
    setGithubProjectSortOverride,
    setShowGitHubProjectSortPicker,
    showGitHubProjectSortPicker,
    taskUiReady
  } = model
  return (
    <PickerModal
      visible={taskUiReady && showGitHubProjectSortPicker}
      title="Project Sort"
      options={githubProjectSortOptions}
      selected={githubProjectSortOverride?.fieldId ?? PROJECT_VIEW_DEFAULT_SORT}
      onSelect={(fieldId) => {
        if (fieldId === PROJECT_VIEW_DEFAULT_SORT) {
          setGithubProjectSortOverride(null)
          return
        }
        setGithubProjectSortOverride((current) => {
          if (!current || current.fieldId !== fieldId) {
            return { fieldId, direction: 'ASC' }
          }
          if (current.direction === 'ASC') {
            return { fieldId, direction: 'DESC' }
          }
          return null
        })
      }}
      onClose={() => setShowGitHubProjectSortPicker(false)}
    />
  )
}
