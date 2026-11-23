import { FilterChip } from '../../../components/nav-bar/FilterChip'
import type { ConnectionPresentationModel } from '../../screen-state/use-mobile-tasks-connection-presentation'
import { clickUpWorkspaceLabel } from './clickup-mobile-connection'
import { clickUpScopeLabel } from './mobile-clickup-filters'

// More than one Workspace adds a picker beside the scope; the status and closed filters live in Filter & display.
export function renderMobileTasksClickUpViewControls(model: ConnectionPresentationModel) {
  const {
    clickupConnection,
    clickupFilter,
    provider,
    setShowClickUpScopePicker,
    setShowClickUpWorkspacePicker,
    taskUiReady
  } = model
  if (provider !== 'clickup' || !clickupConnection.connected) {
    return null
  }
  const workspace = clickupConnection.workspaces.find(
    (entry) => entry.id === clickupConnection.selectedWorkspaceId
  )
  return (
    <>
      {clickupConnection.workspaces.length > 1 && workspace ? (
        <FilterChip
          label={clickUpWorkspaceLabel(workspace)}
          menu
          disabled={!taskUiReady}
          onPress={() => setShowClickUpWorkspacePicker(true)}
        />
      ) : null}
      <FilterChip
        label={clickUpScopeLabel(clickupFilter.scope)}
        menu
        disabled={!taskUiReady}
        onPress={() => setShowClickUpScopePicker(true)}
      />
    </>
  )
}
