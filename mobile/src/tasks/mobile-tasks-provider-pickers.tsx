import type { ConnectionPresentationModel } from './use-mobile-tasks-connection-presentation'
import {
  PickerModal,
  BottomDrawer,
  View,
  Text,
  ScrollView,
  StyleSheet,
  colors,
  spacing,
  textStyles,
  triggerMediumImpact,
  triggerSelection,
  type TaskProvider
} from './mobile-tasks-dependencies'
import {
  normalizeGitHubPreset,
  getTaskPresetQuery,
  githubKindFromQuery,
  scopeGitHubTaskSearch,
  normalizeLinearFilter,
  repositoryCount,
  getRepoBadgeColor,
  getTaskRepoDetail,
  issueSourceSlug,
  GITHUB_KIND_OPTIONS,
  type GitHubMode,
  type GitHubPreset
} from './mobile-tasks-legacy-foundation'
import { normalizeJiraFilter } from './mobile-jira-issue-filters'
import { ListGroup, LIST_LEADING_INSET } from '../components/ui/ListGroup'
import { ListRow } from '../components/ui/ListRow'
import { MobileSegmentedControl } from '../components/MobileSegmentedControl'
import { PickerEmptyState, PickerSheetTitle } from '../components/PickerModal'
import {
  MobileTasksSheetFootnote,
  MobileTasksSheetHeader,
  sheetStyles
} from './mobile-tasks-sheet-chrome'

type ProviderSelectModel = Pick<
  ConnectionPresentationModel,
  | 'githubPreset'
  | 'persistTaskSource'
  | 'setAppliedQuery'
  | 'setGithubKind'
  | 'setGithubMode'
  | 'setGithubPreset'
  | 'setItems'
  | 'setLinearFilter'
  | 'setJiraFilter'
  | 'setProvider'
  | 'setQuery'
  | 'taskResumeRef'
>

/** Switches the task source and restores what the user last had open there. */
export function selectMobileTasksProvider(model: ProviderSelectModel, next: TaskProvider) {
  const {
    githubPreset,
    persistTaskSource,
    setAppliedQuery,
    setGithubKind,
    setGithubMode,
    setGithubPreset,
    setItems,
    setLinearFilter,
    setJiraFilter,
    setProvider,
    setQuery,
    taskResumeRef
  } = model
  const resume = taskResumeRef.current
  persistTaskSource(next)
  setProvider(next)
  setItems([])
  if (next === 'github') {
    const nextMode = resume.githubMode === 'project' ? 'project' : 'items'
    setGithubMode(nextMode)
    if (nextMode === 'project') {
      setQuery('')
      setAppliedQuery('')
      return
    }
    const preset =
      resume.githubItemsPreset === null
        ? githubPreset
        : normalizeGitHubPreset(resume.githubItemsPreset ?? githubPreset)
    const nextQuery =
      resume.githubItemsPreset === null
        ? (resume.githubItemsQuery ?? '')
        : getTaskPresetQuery(preset)
    const nextKind = githubKindFromQuery(nextQuery, preset)
    setGithubPreset(preset)
    setGithubKind(nextKind)
    setQuery(nextQuery)
    setAppliedQuery(scopeGitHubTaskSearch(nextQuery, nextKind))
  } else if (next === 'linear') {
    const nextQuery = resume.linearQuery ?? ''
    setLinearFilter(normalizeLinearFilter(resume.linearPreset))
    setQuery(nextQuery)
    setAppliedQuery(nextQuery.trim())
  } else if (next === 'jira') {
    const nextQuery = resume.jiraQuery ?? ''
    setJiraFilter(normalizeJiraFilter(resume.jiraPreset))
    setQuery(nextQuery)
    setAppliedQuery(nextQuery.trim())
  } else {
    setQuery('')
    setAppliedQuery('')
  }
}

export function renderMobileTasksProviderPicker(model: ConnectionPresentationModel) {
  const { provider, providerOptions, setShowProviderPicker, showProviderPicker, taskUiReady } =
    model
  return (
    <PickerModal
      visible={taskUiReady && showProviderPicker}
      title="Task source"
      options={providerOptions}
      selected={provider}
      onSelect={(next) => selectMobileTasksProvider(model, next)}
      onClose={() => setShowProviderPicker(false)}
    />
  )
}

export function renderMobileTasksRepoPicker(model: ConnectionPresentationModel) {
  const {
    hostedRepos,
    persistRepoSelection,
    effectiveRepoIds,
    repoHostLabels,
    setSelectedRepoIds,
    setShowRepoPicker,
    showRepoPicker,
    taskUiReady,
    toggleRepoSelection
  } = model
  return (
    <BottomDrawer visible={taskUiReady && showRepoPicker} onClose={() => setShowRepoPicker(false)}>
      <MobileTasksSheetHeader
        title="Repositories"
        subtitle="Choose which repositories to query."
        trailing={{ label: 'Done', onPress: () => setShowRepoPicker(false) }}
      />
      <ListGroup separatorInset={LIST_LEADING_INSET} style={sheetStyles.group}>
        <ListRow
          key="all"
          title="All repositories"
          subtitle={repositoryCount(hostedRepos.length)}
          leading={null}
          selected={effectiveRepoIds.size === 0}
          accessibilityRole="button"
          onPress={() => {
            triggerSelection()
            const allSelection = new Set<string>()
            setSelectedRepoIds(allSelection)
            persistRepoSelection(allSelection, hostedRepos)
          }}
        />
        {hostedRepos.map((repo) => (
          <ListRow
            key={repo.id}
            title={repo.displayName}
            subtitle={getTaskRepoDetail(repo, repoHostLabels)}
            leading={
              <View
                style={[
                  sheetStyles.dot,
                  {
                    backgroundColor: getRepoBadgeColor(repo, repo.displayName)
                  }
                ]}
              />
            }
            selected={effectiveRepoIds.has(repo.id)}
            accessibilityRole="button"
            onPress={() => {
              triggerSelection()
              toggleRepoSelection(repo.id)
            }}
          />
        ))}
      </ListGroup>
    </BottomDrawer>
  )
}

/** One repository's Upstream / Origin choice, as the Filter & display sheet and its own sheet show it. */
export function renderMobileTasksIssueSourceRows(model: ConnectionPresentationModel) {
  const { githubIssueSourceRows, setGitHubIssueSourcePreference } = model
  return githubIssueSourceRows.map(({ repo, sources }) => {
    const selectedPreference =
      repo.issueSourcePreference === 'origin' || repo.issueSourcePreference === 'upstream'
        ? repo.issueSourcePreference
        : 'upstream'
    return (
      <View key={repo.id} style={issueSourceStyles.row}>
        <View style={issueSourceStyles.copy}>
          <Text style={issueSourceStyles.title} numberOfLines={1}>
            {repo.displayName}
          </Text>
          <Text style={issueSourceStyles.hint} numberOfLines={1}>
            Querying{' '}
            {issueSourceSlug(
              selectedPreference === 'origin' ? sources.prs : sources.upstreamCandidate
            )}
          </Text>
        </View>
        <MobileSegmentedControl
          segments={ISSUE_SOURCE_SEGMENTS}
          selected={selectedPreference}
          onSelect={(preference) => void setGitHubIssueSourcePreference(repo, preference)}
          testIDPrefix={`mobile-tasks-issue-source-${repo.id}-`}
        />
      </View>
    )
  })
}

export const ISSUE_SOURCE_SEGMENTS = [
  { value: 'upstream', label: 'Upstream' },
  { value: 'origin', label: 'Origin' }
] as const

export function renderMobileTasksGitHubIssueSourcePicker(model: ConnectionPresentationModel) {
  const {
    githubIssueSourceRows,
    setShowGitHubIssueSourcePicker,
    showGitHubIssueSourcePicker,
    taskUiReady
  } = model
  return (
    <BottomDrawer
      visible={taskUiReady && showGitHubIssueSourcePicker}
      onClose={() => setShowGitHubIssueSourcePicker(false)}
    >
      <MobileTasksSheetHeader
        title="Issue sources"
        trailing={{
          label: 'Done',
          onPress: () => setShowGitHubIssueSourcePicker(false)
        }}
      />
      {githubIssueSourceRows.length === 0 ? (
        <PickerEmptyState message="No alternate issue sources available." />
      ) : (
        <>
          <ListGroup style={sheetStyles.group}>{renderMobileTasksIssueSourceRows(model)}</ListGroup>
          <MobileTasksSheetFootnote>
            Choose whether each repository queries and creates work from upstream or origin.
          </MobileTasksSheetFootnote>
        </>
      )}
    </BottomDrawer>
  )
}

/** Issues, PRs or Projects; each restores that view's default preset. */
export function selectMobileTasksGitHubView(model: ConnectionPresentationModel, kind: GitHubMode) {
  const {
    persistTaskResumeState,
    setAppliedQuery,
    setGithubKind,
    setGithubMode,
    setGithubPreset,
    setItems,
    setQuery
  } = model
  if (kind === 'project') {
    setGithubMode('project')
    setItems([])
    persistTaskResumeState({ githubMode: 'project' })
    return
  }
  const preset = kind === 'prs' ? 'prs' : 'issues'
  const nextQuery = getTaskPresetQuery(preset)
  setGithubMode('items')
  setGithubKind(kind)
  setGithubPreset(preset)
  setQuery(nextQuery)
  setAppliedQuery(nextQuery)
  persistTaskResumeState({
    githubMode: 'items',
    githubItemsPreset: preset,
    githubItemsQuery: nextQuery
  })
}

export function renderMobileTasksGitHubViewPicker(model: ConnectionPresentationModel) {
  const { githubKind, githubMode, setShowGitHubKindPicker, showGitHubKindPicker, taskUiReady } =
    model
  return (
    <PickerModal
      visible={taskUiReady && showGitHubKindPicker}
      title="GitHub view"
      options={GITHUB_KIND_OPTIONS}
      selected={githubMode === 'project' ? 'project' : githubKind}
      onSelect={(kind) => selectMobileTasksGitHubView(model, kind)}
      onClose={() => setShowGitHubKindPicker(false)}
    />
  )
}

export function selectMobileTasksGitHubPreset(
  model: ConnectionPresentationModel,
  preset: GitHubPreset
) {
  const {
    persistTaskResumeState,
    setAppliedQuery,
    setGithubKind,
    setGithubMode,
    setGithubPreset,
    setQuery
  } = model
  const nextQuery = getTaskPresetQuery(preset)
  setGithubMode('items')
  setGithubKind(preset === 'issues' || preset === 'my-issues' ? 'issues' : 'prs')
  setGithubPreset(preset)
  setQuery(nextQuery)
  setAppliedQuery(nextQuery)
  persistTaskResumeState({
    githubItemsPreset: preset,
    githubItemsQuery: nextQuery
  })
}

export function renderMobileTasksGitHubPresetPicker(model: ConnectionPresentationModel) {
  const {
    githubKind,
    githubPreset,
    githubPresetPickerOptions,
    persistDefaultGitHubPreset,
    setShowGitHubPresetPicker,
    showGitHubPresetPicker,
    taskUiReady
  } = model
  return (
    <PickerModal
      visible={taskUiReady && showGitHubPresetPicker}
      title={githubKind === 'prs' ? 'Pull requests' : 'Issues'}
      subtitle="Press and hold to make one the default."
      options={githubPresetPickerOptions}
      selected={githubPreset}
      onSelect={(preset) => selectMobileTasksGitHubPreset(model, preset)}
      onLongSelect={(preset) => {
        triggerMediumImpact()
        persistDefaultGitHubPreset(preset)
      }}
      onClose={() => setShowGitHubPresetPicker(false)}
    />
  )
}

export function renderMobileTasksPagePicker(model: ConnectionPresentationModel) {
  const {
    githubCurrentPage,
    githubPagePickerPages,
    githubPages,
    githubPaginationLoading,
    handleGitHubPageChange,
    setShowGitHubPagePicker,
    showGitHubPagePicker,
    taskUiReady
  } = model
  return (
    <BottomDrawer
      visible={taskUiReady && showGitHubPagePicker}
      onClose={() => setShowGitHubPagePicker(false)}
    >
      <PickerSheetTitle title="Go to page" subtitle="Jump to a loaded or available page." />
      <ScrollView style={issueSourceStyles.pageList}>
        <ListGroup style={sheetStyles.group}>
          {githubPagePickerPages.map((index) => (
            <ListRow
              key={`github-page:${index}`}
              title={`Page ${index + 1}`}
              subtitle={index < githubPages.length ? 'Loaded' : 'Loads older results'}
              selected={index === githubCurrentPage}
              disabled={githubPaginationLoading}
              onPress={() => {
                triggerSelection()
                setShowGitHubPagePicker(false)
                void handleGitHubPageChange(index)
              }}
            />
          ))}
        </ListGroup>
      </ScrollView>
    </BottomDrawer>
  )
}

const issueSourceStyles = StyleSheet.create({
  row: {
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md
  },
  copy: { minWidth: 0, gap: 2 },
  title: { ...textStyles.body, fontWeight: '500', color: colors.textPrimary },
  hint: { ...textStyles.footnote, color: colors.textSecondary },
  pageList: { maxHeight: 440 }
})
