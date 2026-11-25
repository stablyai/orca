import type { PersistedUIState } from '../../../../shared/orca-profiles/persisted-ui-state-types'
import type { TopLevelView } from '../../../../shared/ui-chrome/ui-chrome-types'

type ActiveViewUnloadState = {
  activeView: TopLevelView
  persistedUIReady: boolean
}

export function buildActiveViewUnloadPatch(
  state: ActiveViewUnloadState
): Partial<PersistedUIState> {
  // Startup unload must not replace the saved view with defaults before hydration.
  return state.persistedUIReady ? { activeView: state.activeView } : {}
}
