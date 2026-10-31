import type { ConnectionPresentationModel } from './use-mobile-tasks-connection-presentation'
import { FilterChip } from '../components/nav-bar/FilterChip'

/** GitHub's view chip (Issues, PRs, Projects), then its preset or its project. */
export function renderMobileTasksGitHubViewControls(model: ConnectionPresentationModel) {
  const {
    activeProjectLabel,
    githubMode,
    githubModeLabel,
    githubPresetLabel,
    provider,
    setShowGitHubKindPicker,
    setShowGitHubPresetPicker,
    setShowGitHubProjectPicker,
    taskUiReady
  } = model
  if (provider !== 'github') {
    return null
  }
  return (
    <>
      <FilterChip
        label={githubModeLabel}
        menu
        disabled={!taskUiReady}
        onPress={() => setShowGitHubKindPicker(true)}
      />
      {githubMode === 'items' ? (
        <FilterChip
          label={githubPresetLabel}
          menu
          disabled={!taskUiReady}
          onPress={() => setShowGitHubPresetPicker(true)}
        />
      ) : (
        <FilterChip
          label={activeProjectLabel}
          menu
          disabled={!taskUiReady}
          onPress={() => setShowGitHubProjectPicker(true)}
        />
      )}
    </>
  )
}
