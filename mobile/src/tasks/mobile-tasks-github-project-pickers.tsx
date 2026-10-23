import type { ConnectionPresentationModel } from './use-mobile-tasks-connection-presentation'
import {
  BottomDrawer,
  View,
  StyleSheet,
  githubProjectKey,
  MobileSearchField,
  PickerModal,
  spacing,
  triggerSelection
} from './mobile-tasks-dependencies'
import { PROJECT_VIEW_DEFAULT_SORT } from './mobile-tasks-legacy-foundation'
import { Banner } from '../components/ui/Banner'
import { Button } from '../components/ui/Button'
import { ListGroup } from '../components/ui/ListGroup'
import { ListRow } from '../components/ui/ListRow'
import { SectionHeader } from '../components/ui/SectionHeader'
import { StateView } from '../components/ui/StateView'
import { TextField } from '../components/ui/TextField'
import { PickerEmptyState, PickerSheetTitle } from '../components/PickerModal'
import { MobileTasksSheetError, sheetStyles } from './mobile-tasks-sheet-chrome'

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
  const isActive = (key: string) =>
    activeGitHubProject !== null && githubProjectKey(activeGitHubProject) === key
  const pick = (project: Parameters<typeof selectGitHubProject>[0]) => {
    triggerSelection()
    setShowGitHubProjectPicker(false)
    void selectGitHubProject(project)
  }
  const retry = () =>
    void loadGitHubProjects().catch((err) => {
      setGithubProjectError(err instanceof Error ? err.message : 'Failed to load projects')
    })
  return (
    <BottomDrawer
      visible={taskUiReady && showGitHubProjectPicker}
      onClose={() => setShowGitHubProjectPicker(false)}
    >
      <PickerSheetTitle title="GitHub projects" subtitle="Choose a project view for Tasks." />

      <View style={projectPickerStyles.controls}>
        <MobileSearchField
          value={githubProjectPickerSearch}
          onChangeText={setGithubProjectPickerSearch}
          placeholder="Search projects"
          returnKeyType="search"
        />
        <View style={projectPickerStyles.pasteRow}>
          <View style={projectPickerStyles.pasteField}>
            <TextField
              value={githubProjectPasteInput}
              onChangeText={(next) => {
                setGithubProjectPasteInput(next)
                setGithubProjectPasteError('')
              }}
              onSubmitEditing={() => void resolveGitHubProjectFromInput()}
              placeholder="Add by URL or owner/number"
              accessibilityLabel="Add a project by URL or owner/number"
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="go"
              error={Boolean(githubProjectPasteError)}
              footnote={githubProjectPasteError || undefined}
            />
          </View>
          <Button
            label="Add"
            size="compact"
            busy={githubProjectPasteBusy}
            disabled={githubProjectPasteInput.trim().length === 0}
            onPress={() => void resolveGitHubProjectFromInput()}
            style={projectPickerStyles.pasteButton}
          />
        </View>
      </View>

      {githubProjectError ? (
        <MobileTasksSheetError
          error={githubProjectError}
          onDismiss={() => setGithubProjectError('')}
        />
      ) : null}

      {githubProjectPartialFailures.length > 0 ? (
        <View style={projectPickerStyles.banner}>
          <Banner
            tone="warning"
            title={
              githubProjectPartialFailures.length === 1 &&
              githubProjectPartialFailures[0]!.owner !== '*'
                ? `Couldn't load projects from ${githubProjectPartialFailures[0]!.owner}.`
                : `Some organizations didn't load (${githubProjectPartialFailures.length}).`
            }
            message={`Use Add by URL to reach missing projects. ${githubProjectPartialFailures
              .map(
                (failure) => `${failure.owner === '*' ? 'orgs' : failure.owner}: ${failure.message}`
              )
              .join(' · ')}`}
          />
        </View>
      ) : null}

      {githubProjectLoading && githubProjects.length === 0 ? (
        <View style={sheetStyles.loading}>
          <StateView loading title="Loading projects…" />
        </View>
      ) : githubProjects.length === 0 &&
        pinnedGitHubProjects.length === 0 &&
        recentGitHubProjects.length === 0 ? (
        <View style={sheetStyles.loading}>
          <StateView
            title="No projects loaded"
            message="Projects you can see on GitHub show up here."
            secondary={{ label: 'Try again', onPress: retry }}
          />
        </View>
      ) : (
        <>
          {pinnedGitHubProjects.length > 0 ? (
            <>
              <SectionHeader title="Pinned" first />
              <ListGroup style={sheetStyles.group}>
                {pinnedGitHubProjects.map((project) => {
                  const key = githubProjectKey(project)
                  return (
                    <ListRow
                      key={`pinned:${key}`}
                      title={project.summary?.title ?? `#${project.number}`}
                      subtitle={`${project.owner} · #${project.number}`}
                      selected={isActive(key)}
                      onPress={() => pick(project)}
                      accessory={
                        <Button
                          label="Unpin"
                          size="compact"
                          variant="plain"
                          accessibilityLabel={`Unpin ${project.summary?.title ?? `#${project.number}`}`}
                          onPress={() =>
                            persistGitHubProjectSettings({
                              ...githubProjectSettings,
                              pinned: githubProjectSettings.pinned.filter(
                                (entry) => githubProjectKey(entry) !== key
                              )
                            })
                          }
                        />
                      }
                    />
                  )
                })}
              </ListGroup>
            </>
          ) : null}

          {recentGitHubProjects.length > 0 ? (
            <>
              <SectionHeader title="Recent" first={pinnedGitHubProjects.length === 0} />
              <ListGroup style={sheetStyles.group}>
                {recentGitHubProjects.map((project) => {
                  const key = githubProjectKey(project)
                  return (
                    <ListRow
                      key={`recent:${key}`}
                      title={project.summary?.title ?? `#${project.number}`}
                      subtitle={`${project.owner} · #${project.number}`}
                      selected={isActive(key)}
                      onPress={() => pick(project)}
                      accessory={
                        githubProjectSettings.lastViewByProject[key]?.viewId ? (
                          <Button
                            label="Pin"
                            size="compact"
                            variant="plain"
                            accessibilityLabel={`Pin ${project.summary?.title ?? `#${project.number}`}`}
                            onPress={() =>
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
                            }
                          />
                        ) : undefined
                      }
                    />
                  )
                })}
              </ListGroup>
            </>
          ) : null}

          <SectionHeader
            title={githubProjectLoading ? 'All projects (loading…)' : 'All projects'}
            first={pinnedGitHubProjects.length === 0 && recentGitHubProjects.length === 0}
          />
          {browseGitHubProjects.length === 0 ? (
            <PickerEmptyState
              message={
                githubProjectPickerSearch.trim() ? 'No matching projects.' : 'No more projects.'
              }
            />
          ) : (
            <ListGroup style={sheetStyles.group}>
              {browseGitHubProjects.map((project) => (
                <ListRow
                  key={project.id}
                  title={project.title}
                  subtitle={`${project.owner} · #${project.number}`}
                  selected={isActive(githubProjectKey(project))}
                  onPress={() => pick(project)}
                />
              ))}
            </ListGroup>
          )}
        </>
      )}
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
      title={pendingGitHubProjectViewSelection ? 'Choose a project view' : 'Project view'}
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

/** View order, or a field: the first pick sorts ascending, the next descending, the third clears. */
export function cycleMobileTasksGitHubProjectSort(
  model: ConnectionPresentationModel,
  fieldId: string
) {
  const { setGithubProjectSortOverride } = model
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
}

export function renderMobileTasksGitHubProjectSortPicker(model: ConnectionPresentationModel) {
  const {
    githubProjectSortOptions,
    githubProjectSortOverride,
    setShowGitHubProjectSortPicker,
    showGitHubProjectSortPicker,
    taskUiReady
  } = model
  return (
    <PickerModal
      visible={taskUiReady && showGitHubProjectSortPicker}
      title="Sort by"
      options={githubProjectSortOptions}
      selected={githubProjectSortOverride?.fieldId ?? PROJECT_VIEW_DEFAULT_SORT}
      onSelect={(fieldId) => cycleMobileTasksGitHubProjectSort(model, fieldId)}
      onClose={() => setShowGitHubProjectSortPicker(false)}
    />
  )
}

const projectPickerStyles = StyleSheet.create({
  controls: {
    gap: spacing.sm,
    paddingHorizontal: spacing.xs,
    marginBottom: spacing.md
  },
  pasteRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  pasteField: { flex: 1, minWidth: 0 },
  pasteButton: { marginTop: 2 },
  banner: { marginHorizontal: -spacing.sm, marginBottom: spacing.md }
})
