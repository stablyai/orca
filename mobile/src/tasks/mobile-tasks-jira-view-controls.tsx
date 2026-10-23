import type { ConnectionPresentationModel } from './use-mobile-tasks-connection-presentation'
import { FilterChip } from '../components/ui/FilterChip'

// Multiple connected sites add a scope picker beside the issue filter.
export function renderMobileTasksJiraViewControls(model: ConnectionPresentationModel) {
  const {
    provider,
    jiraConnection,
    jiraFilterLabel,
    jiraSiteChipLabel,
    appliedQuery,
    taskUiReady,
    setShowJiraSitePicker,
    setShowJiraFilterPicker
  } = model
  if (provider !== 'jira' || !jiraConnection.connected) {
    return null
  }
  // A JQL search replaces the preset, so the preset chip is shown but locked until it is cleared.
  const queryOverridesPreset = appliedQuery.trim().length > 0
  return (
    <>
      {jiraConnection.sites.length > 1 ? (
        <FilterChip
          label={jiraSiteChipLabel}
          menu
          active={jiraSiteChipLabel !== 'All sites'}
          disabled={!taskUiReady}
          accessibilityLabel={`Site: ${jiraSiteChipLabel}`}
          onPress={() => setShowJiraSitePicker(true)}
        />
      ) : null}
      <FilterChip
        label={queryOverridesPreset ? 'JQL search' : jiraFilterLabel}
        menu={!queryOverridesPreset}
        active={queryOverridesPreset}
        disabled={!taskUiReady || queryOverridesPreset}
        accessibilityLabel={
          queryOverridesPreset
            ? 'Show: your JQL search. Clear the search to pick a preset.'
            : `Show: ${jiraFilterLabel}`
        }
        onPress={() => setShowJiraFilterPicker(true)}
      />
    </>
  )
}
