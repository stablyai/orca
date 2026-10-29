import type { ConnectionPresentationModel } from './use-mobile-tasks-connection-presentation'
import { translate } from '../i18n/mobile-i18n'
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
  const count = githubProjectPartialFailures.length
  return (
    <BottomDrawer
      visible={taskUiReady && showGitHubProjectPicker}
      onClose={() => setShowGitHubProjectPicker(false)}
    >
      <View style={styles.sheetHeader}>
        <Text style={styles.sheetTitle}>
          {translate('tasks.githubProjectPickers.title', 'GitHub Projects')}
        </Text>
        <Text style={styles.sheetSubtitle}>
          {translate(
            'tasks.githubProjectPickers.subtitle',
            'Choose a project view for the Tasks page.'
          )}
        </Text>
      </View>

      <View style={styles.projectPickerControls}>
        <TextInput
          style={styles.input}
          value={githubProjectPickerSearch}
          onChangeText={setGithubProjectPickerSearch}
          placeholder={translate('tasks.githubProjectPickers.searchProjects', 'Search projects')}
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
            placeholder={translate(
              'tasks.githubProjectPickers.addPlaceholder',
              'Add by URL or owner/number'
            )}
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
              {githubProjectPasteBusy
                ? translate('tasks.githubProjectPickers.adding', 'Adding...')
                : translate('tasks.githubProjectPickers.add', 'Add')}
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
                ? translate(
                    'tasks.githubProjectPickers.ownerLoadFailed',
                    "Couldn't load projects from {{owner}}.",
                    {
                      owner: githubProjectPartialFailures[0]!.owner
                    }
                  )
                : translate(
                    'tasks.githubProjectPickers.organizationsLoadFailed',
                    "Some organizations didn't load ({{count}}).",
                    { count }
                  )}
            </Text>
            <Text style={styles.projectWarningText}>
              {translate(
                'tasks.githubProjectPickers.addByUrlHint',
                'Use Add by URL to reach missing projects.'
              )}
            </Text>
            <Text style={styles.projectWarningText} numberOfLines={2}>
              {githubProjectPartialFailures
                .map(({ owner, message }) =>
                  owner === '*'
                    ? translate(
                        'tasks.githubProjectPickers.organizationsError',
                        'orgs: {{message}}',
                        { message }
                      )
                    : `${owner}: ${message}`
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
                  err instanceof Error
                    ? err.message
                    : translate('tasks.githubProjectPickers.loadFailed', 'Failed to load projects')
                )
              })
            }
          >
            <View style={styles.repoPickerTextWrap}>
              <Text style={styles.repoPickerTitle}>
                {translate('tasks.githubProjectPickers.noProjects', 'No projects loaded')}
              </Text>
              <Text style={styles.repoPickerSubtitle}>
                {translate('tasks.githubProjectPickers.retryHint', 'Tap to retry.')}
              </Text>
            </View>
          </Pressable>
        ) : (
          <>
            {pinnedGitHubProjects.length > 0 ? (
              <>
                <Text style={styles.linearStatesTitle}>
                  {translate('tasks.githubProjectPickers.pinned', 'Pinned')}
                </Text>
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
                          <Text style={styles.inlineSaveText}>
                            {translate('common.remove', 'Remove')}
                          </Text>
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
                <Text style={styles.linearStatesTitle}>
                  {translate('tasks.githubProjectPickers.recent', 'Recent')}
                </Text>
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
                            <Text style={styles.inlineSaveText}>
                              {translate('tasks.githubProjectPickers.pin', 'Pin')}
                            </Text>
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
              {githubProjectLoading
                ? translate('tasks.githubProjectPickers.browseLoading', 'Browse all (loading...)')
                : translate('tasks.githubProjectPickers.browseAll', 'Browse all')}
            </Text>
            {browseGitHubProjects.length === 0 ? (
              <Text style={styles.emptyInlineText}>
                {githubProjectPickerSearch.trim()
                  ? translate('tasks.githubProjectPickers.noMatches', 'No matching projects.')
                  : translate('tasks.githubProjectPickers.noMoreProjects', 'No more projects.')}
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
  return (
    <PickerModal
      visible={model.taskUiReady && model.showGitHubProjectViewPicker}
      title={
        model.pendingGitHubProjectViewSelection
          ? translate('tasks.githubProjectPickers.chooseView', 'Choose Project View')
          : translate('tasks.githubProjectPickers.view', 'Project View')
      }
      options={model.githubProjectViewOptions}
      selected={
        model.pendingGitHubProjectViewSelection ? '' : (model.activeGitHubProjectViewId ?? '')
      }
      onSelect={(viewId) => {
        const view = model.githubProjectViews.find((candidate) => candidate.id === viewId)
        if (view && view.layout !== 'TABLE_LAYOUT') {
          model.setGithubProjectError(
            translate(
              'tasks.githubProjectPickers.unsupportedLayout',
              "Orca doesn't support this GitHub Project layout yet."
            )
          )
          return
        }
        if (model.pendingGitHubProjectViewSelection) {
          model.commitGitHubProjectView(model.pendingGitHubProjectViewSelection, viewId)
          model.setPendingGitHubProjectViewSelection(null)
          return
        }
        if (!model.activeGitHubProject || !model.activeGitHubProjectKey) {
          return
        }
        model.commitGitHubProjectView(model.activeGitHubProject, viewId)
      }}
      onClose={() => {
        model.setShowGitHubProjectViewPicker(false)
        if (model.pendingGitHubProjectViewSelection) {
          model.setPendingGitHubProjectViewSelection(null)
        }
      }}
    />
  )
}

export function renderMobileTasksGitHubProjectSortPicker(model: ConnectionPresentationModel) {
  return (
    <PickerModal
      visible={model.taskUiReady && model.showGitHubProjectSortPicker}
      title={translate('tasks.githubProjectPickers.sort', 'Project Sort')}
      options={model.githubProjectSortOptions}
      selected={model.githubProjectSortOverride?.fieldId ?? PROJECT_VIEW_DEFAULT_SORT}
      onSelect={(fieldId) => {
        if (fieldId === PROJECT_VIEW_DEFAULT_SORT) {
          model.setGithubProjectSortOverride(null)
          return
        }
        model.setGithubProjectSortOverride((current) => {
          if (!current || current.fieldId !== fieldId) {
            return { fieldId, direction: 'ASC' }
          }
          if (current.direction === 'ASC') {
            return { fieldId, direction: 'DESC' }
          }
          return null
        })
      }}
      onClose={() => model.setShowGitHubProjectSortPicker(false)}
    />
  )
}
