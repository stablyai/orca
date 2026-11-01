import type { ReactNode } from 'react'
import type { ConnectionPresentationModel } from './use-mobile-tasks-connection-presentation'
import { translate } from '../i18n/mobile-i18n'
import {
  BottomDrawer,
  View,
  Text,
  TextField,
  Search,
  colors,
  Pressable,
  AlertTriangle,
  ActivityIndicator,
  githubProjectKey,
  PickerModal,
  type GitHubProjectRef
} from './mobile-tasks-dependencies'
import { ListGroup, SectionHeader, ListRow } from '../components/list/ListGroup'
import { styles } from './mobile-tasks-legacy-styles'
import { PROJECT_VIEW_DEFAULT_SORT } from './mobile-tasks-legacy-foundation'
import { pressedStyle } from '../theme/mobile-theme'

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
  const isActiveProject = (project: GitHubProjectRef) =>
    activeGitHubProject !== null &&
    githubProjectKey(activeGitHubProject) === githubProjectKey(project)
  const inlineAction = (label: string, run: () => void) => (
    <Pressable
      style={({ pressed }) => [styles.inlineSaveButtonCompact, pressed && pressedStyle]}
      onPress={(event) => {
        event.stopPropagation()
        run()
      }}
    >
      <Text style={styles.inlineSaveText}>{label}</Text>
    </Pressable>
  )
  const projectRow = (key: string, project: GitHubProjectRef, title: string, action: ReactNode) => (
    <ListRow
      key={key}
      title={title}
      subtitle={`${project.owner} · #${project.number}`}
      accessory={action}
      selected={isActiveProject(project)}
      onPress={() => {
        setShowGitHubProjectPicker(false)
        void selectGitHubProject(project)
      }}
    />
  )
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
        <TextField
          value={githubProjectPickerSearch}
          onChangeText={setGithubProjectPickerSearch}
          placeholder={translate('tasks.githubProjectPickers.searchProjects', 'Search projects')}
          leading={<Search size={16} color={colors.textMuted} />}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <View style={styles.projectPasteRow}>
          <TextField
            style={styles.projectPasteInput}
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
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Pressable
            style={({ pressed }) => [
              styles.inlineSaveButtonCompact,
              styles.projectPasteButton,
              pressed && pressedStyle
            ]}
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

      {githubProjectLoading && githubProjects.length === 0 ? (
        <ListGroup>
          <View key="loading" style={styles.drawerLoadingRow}>
            <ActivityIndicator size="small" color={colors.textSecondary} />
          </View>
        </ListGroup>
      ) : githubProjects.length === 0 &&
        pinnedGitHubProjects.length === 0 &&
        recentGitHubProjects.length === 0 ? (
        <ListGroup>
          <ListRow
            key="retry"
            title={translate('tasks.githubProjectPickers.noProjects', 'No projects loaded')}
            subtitle={translate('tasks.githubProjectPickers.retryHint', 'Tap to retry.')}
            onPress={() =>
              void loadGitHubProjects().catch((err) => {
                setGithubProjectError(
                  err instanceof Error
                    ? err.message
                    : translate('tasks.githubProjectPickers.loadFailed', 'Failed to load projects')
                )
              })
            }
          />
        </ListGroup>
      ) : (
        <>
          {pinnedGitHubProjects.length > 0 ? (
            <>
              <SectionHeader
                title={translate('tasks.githubProjectPickers.pinned', 'Pinned')}
                first
              />
              <ListGroup>
                {pinnedGitHubProjects.map((project) => {
                  const key = githubProjectKey(project)
                  return projectRow(
                    `pinned:${key}`,
                    project,
                    project.summary?.title ?? `#${project.number}`,
                    inlineAction(translate('common.remove', 'Remove'), () =>
                      persistGitHubProjectSettings({
                        ...githubProjectSettings,
                        pinned: githubProjectSettings.pinned.filter(
                          (entry) => githubProjectKey(entry) !== key
                        )
                      })
                    )
                  )
                })}
              </ListGroup>
            </>
          ) : null}

          {recentGitHubProjects.length > 0 ? (
            <>
              <SectionHeader title={translate('tasks.githubProjectPickers.recent', 'Recent')} />
              <ListGroup>
                {recentGitHubProjects.map((project) => {
                  const key = githubProjectKey(project)
                  return projectRow(
                    `recent:${key}`,
                    project,
                    project.summary?.title ?? `#${project.number}`,
                    githubProjectSettings.lastViewByProject[key]?.viewId
                      ? inlineAction(translate('tasks.githubProjectPickers.pin', 'Pin'), () =>
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
                        )
                      : undefined
                  )
                })}
              </ListGroup>
            </>
          ) : null}

          <SectionHeader
            title={
              githubProjectLoading
                ? translate('tasks.githubProjectPickers.browseLoading', 'Browse all (loading...)')
                : translate('tasks.githubProjectPickers.browseAll', 'Browse all')
            }
          />
          {browseGitHubProjects.length === 0 ? (
            <Text style={styles.emptyInlineText}>
              {githubProjectPickerSearch.trim()
                ? translate('tasks.githubProjectPickers.noMatches', 'No matching projects.')
                : translate('tasks.githubProjectPickers.noMoreProjects', 'No more projects.')}
            </Text>
          ) : (
            <ListGroup>
              {browseGitHubProjects.map((project) =>
                projectRow(project.id, project, project.title, undefined)
              )}
            </ListGroup>
          )}
        </>
      )}
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

// Picking the active field again flips it to descending, then back to the view's own order.
export function cycleMobileTasksGitHubProjectSort(
  model: ConnectionPresentationModel,
  fieldId: string
) {
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
}
