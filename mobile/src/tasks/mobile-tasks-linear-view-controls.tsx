import type { ConnectionPresentationModel } from './use-mobile-tasks-connection-presentation'
import { FilterChip } from '../components/ui/FilterChip'

/** Linear's team scope and its quick filter; layout, grouping and order live in Filter & display. */
export function renderMobileTasksLinearViewControls(model: ConnectionPresentationModel) {
  const {
    linearConnected,
    linearFilterLabel,
    linearTeamLabel,
    provider,
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
        active={linearTeamLabel !== 'All teams'}
        disabled={!taskUiReady}
        accessibilityLabel={`Teams: ${linearTeamLabel}`}
        onPress={() => setShowLinearTeamPicker(true)}
      />
      <FilterChip
        label={linearFilterLabel}
        menu
        disabled={!taskUiReady}
        accessibilityLabel={`Show: ${linearFilterLabel}`}
        onPress={() => setShowLinearFilterPicker(true)}
      />
    </>
  )
}
