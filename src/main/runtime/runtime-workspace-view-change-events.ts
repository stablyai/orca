import { isDeepStrictEqual } from 'node:util'
import type { RuntimeClientEvent } from '../../shared/runtime-client-events'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { PersistedUIState } from '../../shared/persisted-ui-state-types'
import { ALL_WORKSPACE_VIEW_UI_FIELDS } from '../../shared/workspace-view/workspace-view-ui-fields'
import type { RuntimeStore } from './runtime-store-contract'

/** The settings a phone's workspace list mirrors: Card layout, card style and pinned placement. */
const WORKSPACE_VIEW_SETTINGS: readonly (keyof GlobalSettings)[] = [
  'compactWorktreeCards',
  'experimentalNewWorktreeCardStyle',
  'showPinnedWorktreesInGroups'
]

function workspaceViewUiValues(ui: PersistedUIState): unknown[] {
  return ALL_WORKSPACE_VIEW_UI_FIELDS.map((key) => ui[key])
}

/** Publish workspace-option changes promptly without re-reading on every UI drag frame. */
export function publishWorkspaceViewChanges(
  store: Pick<RuntimeStore, 'getUI' | 'onUIChanged' | 'onSettingsChanged'> | null,
  emit: (event: RuntimeClientEvent) => void
): void {
  if (!store?.getUI || !store.onUIChanged) {
    return
  }
  let previous = workspaceViewUiValues(store.getUI())
  store.onUIChanged((ui) => {
    const next = workspaceViewUiValues(ui)
    if (!isDeepStrictEqual(previous, next)) {
      previous = next
      emit({ type: 'workspaceViewChanged' })
    }
  })
  store.onSettingsChanged?.((updates) => {
    if (WORKSPACE_VIEW_SETTINGS.some((key) => key in updates)) {
      emit({ type: 'workspaceViewChanged' })
    }
  })
}
