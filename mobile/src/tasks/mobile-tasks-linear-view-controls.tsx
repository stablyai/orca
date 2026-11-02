import type { ConnectionPresentationModel } from './use-mobile-tasks-connection-presentation'
import { FilterChip } from '../components/nav-bar/FilterChip'

/** Linear's team scope and its quick filter; layout, grouping and order live in Filter & display. */
export function renderMobileTasksLinearViewControls(model: ConnectionPresentationModel) {
  const {
    linearConnected,
    linearFilterLabel,
    linearTeamLabel,
    linearTeams,
    provider,
    selectedLinearTeamIds,
    setShowLinearFilterPicker,
    setShowLinearTeamPicker,
    taskUiReady
  } = model
  if (provider !== 'linear' || !linearConnected) {
    return null
  }
  return (
    <>
      <FilterChip
        label={linearTeamLabel}
        menu
        active={selectedLinearTeamIds.size > 0 && selectedLinearTeamIds.size < linearTeams.length}
        disabled={!taskUiReady}
        onPress={() => setShowLinearTeamPicker(true)}
      />
      <FilterChip
        label={linearFilterLabel}
        menu
        disabled={!taskUiReady}
        onPress={() => setShowLinearFilterPicker(true)}
      />
    </>
  )
}
