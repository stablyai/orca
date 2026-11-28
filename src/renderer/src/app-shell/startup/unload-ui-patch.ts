import type { PersistedUIState } from '../../../../shared/orca-profiles/persisted-ui-state-types'
import type { AppState } from '../../store/types'

type UnloadUIState = Pick<
  AppState,
  | 'activeView'
  | 'persistedUIReady'
  | 'persistedUIWriteBaseline'
  | 'persistedUIWriteInFlightCounts'
  | 'uiZoomLevel'
  | 'sidebarZoomLevel'
>

export function buildUnloadUIPatch(state: UnloadUIState): Partial<PersistedUIState> {
  if (!state.persistedUIReady) {
    return {}
  }
  const patch: Partial<PersistedUIState> = { activeView: state.activeView }
  // A close can beat the zoom writer's debounce or its acknowledgement.
  for (const field of ['uiZoomLevel', 'sidebarZoomLevel'] as const) {
    if (
      state.persistedUIWriteBaseline &&
      (state[field] !== state.persistedUIWriteBaseline[field] ||
        state.persistedUIWriteInFlightCounts[field])
    ) {
      patch[field] = state[field]
    }
  }
  return patch
}
