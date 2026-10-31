import type { ConnectionPresentationModel } from './use-mobile-tasks-connection-presentation'
import {
  PickerModal,
  BottomDrawer,
  View,
  Text,
  Pressable,
  Check,
  colors,
  ScrollView,
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
  GITHUB_KIND_OPTIONS
} from './mobile-tasks-legacy-foundation'
import { styles } from './mobile-tasks-legacy-styles'
import { normalizeJiraFilter } from './mobile-jira-issue-filters'
import { translate as t } from '../i18n/mobile-i18n'

// Restores the provider's last view and query so switching sources round-trips.
export function selectMobileTasksProvider(model: ConnectionPresentationModel, next: TaskProvider) {
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
      <View style={styles.sheetHeader}>
        <Text style={styles.sheetTitle}>{t('tasks.providerPickers.repos', 'Repositories')}</Text>
        <Text style={styles.sheetSubtitle}>
          {t('tasks.providerPickers.repoDescription', 'Choose which repositories to query.')}
        </Text>
      </View>

      <View style={styles.repoPickerGroup}>
        <Pressable
          style={styles.repoPickerRow}
          onPress={() => {
            const allSelection = new Set<string>()
            setSelectedRepoIds(allSelection)
            persistRepoSelection(allSelection, hostedRepos)
          }}
        >
          <View style={styles.repoPickerTextWrap}>
            <Text style={styles.repoPickerTitle}>
              {t('tasks.providerPickers.allRepositories', 'All repositories')}
            </Text>
            <Text style={styles.repoPickerSubtitle}>{repositoryCount(hostedRepos.length)}</Text>
          </View>
          {effectiveRepoIds.size === 0 ? <Check size={15} color={colors.textPrimary} /> : null}
        </Pressable>

        {hostedRepos.map((repo) => {
          const selected = effectiveRepoIds.has(repo.id)
          return (
            <View key={repo.id}>
              <View style={styles.actionSeparator} />
              <Pressable style={styles.repoPickerRow} onPress={() => toggleRepoSelection(repo.id)}>
                <View
                  style={[styles.pickerRepoDot, { backgroundColor: getRepoBadgeColor(repo) }]}
                />
                <View style={styles.repoPickerTextWrap}>
                  <Text style={styles.repoPickerTitle} numberOfLines={1}>
                    {repo.displayName}
                  </Text>
                  <Text style={styles.repoPickerSubtitle} numberOfLines={1}>
                    {getTaskRepoDetail(repo, repoHostLabels)}
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

export function renderMobileTasksGitHubIssueSourcePicker(model: ConnectionPresentationModel) {
  const {
    githubIssueSourceRows,
    setGitHubIssueSourcePreference,
    setShowGitHubIssueSourcePicker,
    showGitHubIssueSourcePicker,
    taskUiReady
  } = model
  return (
    <BottomDrawer
      visible={taskUiReady && showGitHubIssueSourcePicker}
      onClose={() => setShowGitHubIssueSourcePicker(false)}
    >
      <View style={styles.sheetHeader}>
        <Text style={styles.sheetTitle}>
          {t('tasks.providerPickers.issueSources', 'GitHub Issue Sources')}
        </Text>
        <Text style={styles.sheetSubtitle}>
          {t(
            'tasks.providerPickers.issueSourcesDescription',
            'Choose whether each repository queries and creates work from upstream or origin.'
          )}
        </Text>
      </View>

      <View style={styles.repoPickerGroup}>
        {githubIssueSourceRows.length === 0 ? (
          <View style={styles.drawerLoadingRow}>
            <Text style={styles.detailMuted}>
              {t('tasks.providerPickers.noIssueSources', 'No alternate issue sources available.')}
            </Text>
          </View>
        ) : (
          githubIssueSourceRows.map(({ repo, sources }, index) => {
            const selectedPreference =
              repo.issueSourcePreference === 'origin' || repo.issueSourcePreference === 'upstream'
                ? repo.issueSourcePreference
                : 'upstream'
            return (
              <View key={repo.id}>
                {index > 0 ? <View style={styles.actionSeparator} /> : null}
                <View style={styles.issueSourceBox}>
                  <View style={styles.repoPickerTextWrap}>
                    <Text style={styles.repoPickerTitle} numberOfLines={1}>
                      {repo.displayName}
                    </Text>
                    <Text style={styles.issueSourceHint} numberOfLines={2}>
                      {t('tasks.providerPickers.queryingSource', 'Querying {{source}}', {
                        source: issueSourceSlug(
                          selectedPreference === 'origin' ? sources.prs : sources.upstreamCandidate
                        )
                      })}
                    </Text>
                  </View>
                  <View style={styles.issueSourceSegment}>
                    {(['upstream', 'origin'] as const).map((preference) => {
                      const selected = selectedPreference === preference
                      const slug =
                        preference === 'upstream'
                          ? issueSourceSlug(sources.upstreamCandidate)
                          : issueSourceSlug(sources.prs)
                      return (
                        <Pressable
                          key={preference}
                          style={[
                            styles.issueSourceSegmentButton,
                            selected && styles.issueSourceSegmentButtonActive
                          ]}
                          accessibilityState={{ selected }}
                          onPress={() => void setGitHubIssueSourcePreference(repo, preference)}
                        >
                          <Text
                            style={[
                              styles.issueSourceSegmentText,
                              selected && styles.issueSourceSegmentTextActive
                            ]}
                          >
                            {preference === 'upstream'
                              ? t('tasks.providerPickers.upstream', 'Upstream')
                              : t('tasks.providerPickers.origin', 'Origin')}
                          </Text>
                          <Text style={styles.issueSourceSlug} numberOfLines={1}>
                            {slug}
                          </Text>
                        </Pressable>
                      )
                    })}
                  </View>
                </View>
              </View>
            )
          })
        )}
      </View>
    </BottomDrawer>
  )
}

export function renderMobileTasksGitHubViewPicker(model: ConnectionPresentationModel) {
  const {
    githubKind,
    githubMode,
    persistTaskResumeState,
    setAppliedQuery,
    setGithubKind,
    setGithubMode,
    setGithubPreset,
    setItems,
    setQuery,
    setShowGitHubKindPicker,
    showGitHubKindPicker,
    taskUiReady
  } = model
  return (
    <PickerModal
      visible={taskUiReady && showGitHubKindPicker}
      title={t('tasks.providerPickers.githubView', 'GitHub View')}
      options={GITHUB_KIND_OPTIONS}
      selected={githubMode === 'project' ? 'project' : githubKind}
      onSelect={(kind) => {
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
      }}
      onClose={() => setShowGitHubKindPicker(false)}
    />
  )
}

export function renderMobileTasksGitHubPresetPicker(model: ConnectionPresentationModel) {
  const {
    githubKind,
    githubPreset,
    githubPresetPickerOptions,
    persistDefaultGitHubPreset,
    persistTaskResumeState,
    setAppliedQuery,
    setGithubKind,
    setGithubMode,
    setGithubPreset,
    setQuery,
    setShowGitHubPresetPicker,
    showGitHubPresetPicker,
    taskUiReady
  } = model
  return (
    <PickerModal
      visible={taskUiReady && showGitHubPresetPicker}
      title={
        githubKind === 'prs'
          ? t('tasks.providerPickers.pullRequests', 'Pull Requests')
          : t('tasks.providerPickers.issues', 'Issues')
      }
      options={githubPresetPickerOptions}
      selected={githubPreset}
      onSelect={(preset) => {
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
      }}
      onLongSelect={persistDefaultGitHubPreset}
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
      <View style={styles.sheetHeader}>
        <Text style={styles.sheetTitle}>{t('tasks.providerPickers.pages', 'GitHub Pages')}</Text>
        <Text style={styles.sheetSubtitle}>
          {t('tasks.providerPickers.pageHint', 'Jump to a loaded or available result page.')}
        </Text>
      </View>
      <ScrollView style={styles.pagePickerList}>
        {githubPagePickerPages.map((index) => {
          const selected = index === githubCurrentPage
          const loaded = index < githubPages.length
          return (
            <Pressable
              key={`github-page:${index}`}
              style={[styles.pickerRow, selected && styles.pickerRowSelected]}
              disabled={githubPaginationLoading}
              onPress={() => {
                setShowGitHubPagePicker(false)
                void handleGitHubPageChange(index)
              }}
            >
              <View style={styles.pickerRowContent}>
                <Text style={styles.pickerRowLabel}>
                  {t('tasks.providerPickers.pageNumber', 'Page {{page}}', {
                    page: index + 1
                  })}
                </Text>
                <Text style={styles.pickerRowSubtitle}>
                  {loaded
                    ? t('tasks.providerPickers.pageLoaded', 'Loaded')
                    : t('tasks.providerPickers.pageNotLoaded', 'Loads older results')}
                </Text>
              </View>
              {selected ? <Check size={16} color={colors.textPrimary} /> : null}
            </Pressable>
          )
        })}
      </ScrollView>
    </BottomDrawer>
  )
}
