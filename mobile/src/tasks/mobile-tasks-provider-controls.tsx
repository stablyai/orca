import type { PageChromeModel } from './use-mobile-tasks-page-chrome'
import { ScrollView, SlidersHorizontal } from './mobile-tasks-dependencies'
import { styles } from './mobile-tasks-legacy-styles'
import { FilterChip } from '../components/ui/FilterChip'
import { renderMobileTasksGitHubViewControls } from './mobile-tasks-github-view-controls'
import { renderMobileTasksLinearViewControls } from './mobile-tasks-linear-view-controls'
import { renderMobileTasksJiraViewControls } from './mobile-tasks-jira-view-controls'
import { mobileTasksFilterCount } from './mobile-tasks-filter-sheet'

/** The scope and quick-filter chips, then the one Filter button that opens Filter & display. */
export function renderMobileTasksProviderControls(model: PageChromeModel) {
  const {
    githubMode,
    gitlabFilterLabel,
    gitlabView,
    provider,
    repoPickerLabel,
    setShowFilterSheet,
    setShowGitLabFilterPicker,
    setShowGitLabViewPicker,
    setShowRepoPicker,
    taskUiReady
  } = model
  const filterCount = mobileTasksFilterCount(model)
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      style={styles.toolbarScroll}
      contentContainerStyle={styles.toolbar}
    >
      {provider === 'gitlab' || (provider === 'github' && githubMode !== 'project') ? (
        <FilterChip
          label={repoPickerLabel}
          menu
          active={repoPickerLabel !== 'All repos'}
          disabled={!taskUiReady}
          accessibilityLabel={`Repositories: ${repoPickerLabel}`}
          onPress={() => setShowRepoPicker(true)}
        />
      ) : null}

      {renderMobileTasksGitHubViewControls(model)}

      {provider === 'gitlab' ? (
        <>
          <FilterChip
            label={gitlabView === 'project' ? 'Project MRs' : 'My todos'}
            menu
            disabled={!taskUiReady}
            accessibilityLabel={`View: ${gitlabView === 'project' ? 'Project MRs' : 'My todos'}`}
            onPress={() => setShowGitLabViewPicker(true)}
          />
          {gitlabView === 'project' ? (
            <FilterChip
              label={gitlabFilterLabel}
              menu
              disabled={!taskUiReady}
              accessibilityLabel={`Show: ${gitlabFilterLabel}`}
              onPress={() => setShowGitLabFilterPicker(true)}
            />
          ) : null}
        </>
      ) : null}

      {renderMobileTasksLinearViewControls(model)}

      {renderMobileTasksJiraViewControls(model)}

      {(provider !== 'linear' || model.linearConnected) &&
      (provider !== 'jira' || model.jiraConnection.connected) ? (
        <FilterChip
          label={filterCount > 0 ? `Filter · ${filterCount}` : 'Filter'}
          icon={SlidersHorizontal}
          active={filterCount > 0}
          disabled={!taskUiReady}
          accessibilityLabel={
            filterCount > 0 ? `Filter and display, ${filterCount} changed` : 'Filter and display'
          }
          testID="mobile-tasks-filter-button"
          onPress={() => setShowFilterSheet(true)}
        />
      ) : null}
    </ScrollView>
  )
}
