import type { ReactNode } from 'react'
import type { ConnectionPresentationModel } from '../screen-state/use-mobile-tasks-connection-presentation'
import { BottomDrawer } from '../../components/bottom-drawer/BottomDrawer'
import { View, Text, Pressable, ActivityIndicator } from 'react-native'
import { TextField } from '../../components/composer-input/TextField'
import { Search, AlertTriangle } from 'lucide-react-native'
import { pressedStyle } from '../../theme/mobile-theme'
import {
  githubProjectIdentityKey as githubProjectKey,
  toGitHubProjectIdentity,
  type GitHubProjectIdentity as GitHubProjectRef
} from '../../../../src/shared/github/projects/project-identity'
import { PickerModal } from '../../components/sheets/PickerModal'
import { ListGroup, SectionHeader, ListRow } from '../../components/list/ListGroup'
import {
  PROJECT_VIEW_DEFAULT_SORT,
  TASK_SECONDARY_DRAWER_Z_INDEX
} from '../task-list/mobile-tasks-options'

export function renderMobileTasksGitHubProjectPicker(model: ConnectionPresentationModel) {
  const { setShowGitHubProjectPicker, showGitHubProjectPicker, styles, t, taskUiReady } = model
  return (
    <BottomDrawer
      visible={taskUiReady && showGitHubProjectPicker}
      onClose={() => setShowGitHubProjectPicker(false)}
    >
      <View style={styles.sheetHeader}>
        <Text style={styles.sheetTitle}>
          {t('tasks.githubProjectPickers.title', 'GitHub Projects')}
        </Text>
        <Text style={styles.sheetSubtitle}>
          {t('tasks.githubProjectPickers.subtitle', 'Choose a project view for the Tasks page.')}
        </Text>
      </View>
      {renderMobileTasksGitHubProjectPickerBody(model, () => setShowGitHubProjectPicker(false))}
    </BottomDrawer>
  )
}

/** Search, add by URL, and the pinned, recent and browsable projects; `onPicked` leaves the picker. */
export function renderMobileTasksGitHubProjectPickerBody(
  model: ConnectionPresentationModel,
  onPicked: () => void
) {
  const {
    activeGitHubProject,
    browseGitHubProjects,
    colors,
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
    styles,
    t
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
        onPicked()
        void selectGitHubProject(project)
      }}
    />
  )
  return (
    <>
      <View style={styles.projectPickerControls}>
        <TextField
          value={githubProjectPickerSearch}
          onChangeText={setGithubProjectPickerSearch}
          placeholder={t('tasks.githubProjectPickers.searchProjects', 'Search projects')}
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
            placeholder={t(
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
                ? t('tasks.githubProjectPickers.adding', 'Adding...')
                : t('tasks.githubProjectPickers.add', 'Add')}
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
                ? t(
                    'tasks.githubProjectPickers.ownerLoadFailed',
                    "Couldn't load projects from {{owner}}.",
                    {
                      owner: githubProjectPartialFailures[0]!.owner
                    }
                  )
                : t(
                    'tasks.githubProjectPickers.organizationsLoadFailed',
                    "Some organizations didn't load ({{count}}).",
                    { count }
                  )}
            </Text>
            <Text style={styles.projectWarningText}>
              {t(
                'tasks.githubProjectPickers.addByUrlHint',
                'Use Add by URL to reach missing projects.'
              )}
            </Text>
            <Text style={styles.projectWarningText} numberOfLines={2}>
              {githubProjectPartialFailures
                .map(({ owner, message }) =>
                  owner === '*'
                    ? t('tasks.githubProjectPickers.organizationsError', 'orgs: {{message}}', {
                        message
                      })
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
            title={t('tasks.githubProjectPickers.noProjects', 'No projects loaded')}
            subtitle={t('tasks.githubProjectPickers.retryHint', 'Tap to retry.')}
            onPress={() =>
              void loadGitHubProjects().catch((err) => {
                setGithubProjectError(
                  err instanceof Error
                    ? err.message
                    : t('tasks.githubProjectPickers.loadFailed', 'Failed to load projects')
                )
              })
            }
          />
        </ListGroup>
      ) : (
        <>
          {pinnedGitHubProjects.length > 0 ? (
            <>
              <SectionHeader title={t('tasks.githubProjectPickers.pinned', 'Pinned')} first />
              <ListGroup>
                {pinnedGitHubProjects.map((project) => {
                  const key = githubProjectKey(project)
                  return projectRow(
                    `pinned:${key}`,
                    project,
                    project.summary?.title ?? `#${project.number}`,
                    inlineAction(t('common.remove', 'Remove'), () =>
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
              <SectionHeader title={t('tasks.githubProjectPickers.recent', 'Recent')} />
              <ListGroup>
                {recentGitHubProjects.map((project) => {
                  const key = githubProjectKey(project)
                  return projectRow(
                    `recent:${key}`,
                    project,
                    project.summary?.title ?? `#${project.number}`,
                    githubProjectSettings.lastViewByProject[key]?.viewId
                      ? inlineAction(t('tasks.githubProjectPickers.pin', 'Pin'), () =>
                          persistGitHubProjectSettings({
                            ...githubProjectSettings,
                            pinned: [
                              ...githubProjectSettings.pinned,
                              toGitHubProjectIdentity(project)
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
                ? t('tasks.githubProjectPickers.browseLoading', 'Browse all (loading...)')
                : t('tasks.githubProjectPickers.browseAll', 'Browse all')
            }
          />
          {browseGitHubProjects.length === 0 ? (
            <Text style={styles.emptyInlineText}>
              {githubProjectPickerSearch.trim()
                ? t('tasks.githubProjectPickers.noMatches', 'No matching projects.')
                : t('tasks.githubProjectPickers.noMoreProjects', 'No more projects.')}
            </Text>
          ) : (
            <ListGroup>
              {browseGitHubProjects.map((project) =>
                projectRow(`browse:${githubProjectKey(project)}`, project, project.title, undefined)
              )}
            </ListGroup>
          )}
        </>
      )}
    </>
  )
}

export function renderMobileTasksGitHubProjectViewPicker(model: ConnectionPresentationModel) {
  const { t } = model
  const pending = model.pendingGitHubProjectViewSelection
  return (
    <PickerModal
      visible={model.taskUiReady && model.showGitHubProjectViewPicker}
      title={
        pending
          ? t('tasks.githubProjectPickers.chooseView', 'Choose Project View')
          : t('tasks.githubProjectPickers.view', 'Project View')
      }
      options={model.githubProjectViewOptions}
      selected={pending ? '' : (model.activeGitHubProjectViewId ?? '')}
      onSelect={(viewId) => selectMobileTasksGitHubProjectView(model, viewId)}
      // Asked for from the Filter sheet's project page too, so it layers over that sheet.
      zIndex={TASK_SECONDARY_DRAWER_Z_INDEX}
      onClose={() => {
        model.setShowGitHubProjectViewPicker(false)
        if (pending) {
          model.setPendingGitHubProjectViewSelection(null)
        }
      }}
    />
  )
}

export function selectMobileTasksGitHubProjectView(
  model: ConnectionPresentationModel,
  viewId: string
) {
  const pending = model.pendingGitHubProjectViewSelection
  const view = (pending?.views ?? model.githubProjectViews).find(
    (candidate) => candidate.id === viewId
  )
  if (view && view.layout !== 'TABLE_LAYOUT') {
    model.setGithubProjectError(
      model.t(
        'tasks.githubProjectPickers.unsupportedLayout',
        "Orca doesn't support this GitHub Project layout yet."
      )
    )
    return
  }
  if (pending) {
    model.commitGitHubProjectView(pending.project, viewId, pending.views)
    model.setPendingGitHubProjectViewSelection(null)
    return
  }
  if (!model.activeGitHubProject || !model.activeGitHubProjectKey) {
    return
  }
  model.commitGitHubProjectView(model.activeGitHubProject, viewId)
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
