import type { ConnectionPresentationModel } from './use-mobile-tasks-connection-presentation'
import { translate } from '../i18n/mobile-i18n'
import { FilterChip } from '../components/nav-bar/FilterChip'

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
  // A JQL search replaces the preset, so its chip stays visible but locked until the search is cleared.
  const queryOverridesPreset = appliedQuery.trim().length > 0
  return (
    <>
      {jiraConnection.sites.length > 1 ? (
        <FilterChip
          label={jiraSiteChipLabel}
          menu
          active={Boolean(jiraConnection.selection) && jiraConnection.selection !== 'all'}
          disabled={!taskUiReady}
          onPress={() => setShowJiraSitePicker(true)}
        />
      ) : null}
      <FilterChip
        label={
          queryOverridesPreset
            ? translate('tasks.jiraViewControls.jqlSearch', 'JQL search')
            : jiraFilterLabel
        }
        menu={!queryOverridesPreset}
        active={queryOverridesPreset}
        disabled={!taskUiReady || queryOverridesPreset}
        onPress={() => setShowJiraFilterPicker(true)}
      />
    </>
  )
}
