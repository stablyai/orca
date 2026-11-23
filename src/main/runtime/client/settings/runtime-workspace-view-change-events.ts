import { isDeepStrictEqual } from 'node:util'
import type { RuntimeClientEvent } from '../../../../shared/remote-runtime/session-graph/runtime-client-events'
import type { GlobalSettings } from '../../../../shared/settings/global-settings-types'
import type { PersistedUIState } from '../../../../shared/orca-profiles/persisted-ui-state-types'
import { normalizeBotSidebarView } from '../../../../shared/bots/bot-sidebar-view'
import { ALL_WORKSPACE_VIEW_UI_FIELDS } from '../../../../shared/workspace-view/workspace-view-ui-fields'
import type { RuntimeStore } from '../../construction/runtime-store-contract'

/** The settings a phone's workspace list mirrors: Card layout, card style and pinned placement. */
const WORKSPACE_VIEW_SETTINGS: readonly (keyof GlobalSettings)[] = [
  'compactWorktreeCards',
  'experimentalNewWorktreeCardStyle',
  'worktreeCardDetailsRow',
  'hidePrimaryWorktreeMarker',
  'worktreeIndentPx',
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

/** Bot options order and filter a phone's Bots list too; it re-reads that list on botsChanged. */
export function publishBotSidebarViewChanges(
  store: Pick<RuntimeStore, 'getUI' | 'onUIChanged'> | null,
  notifyBotsChanged: () => void
): void {
  if (!store?.getUI || !store.onUIChanged) {
    return
  }
  let previous = normalizeBotSidebarView(store.getUI().botSidebarView)
  store.onUIChanged((ui) => {
    const next = normalizeBotSidebarView(ui.botSidebarView)
    if (!isDeepStrictEqual(previous, next)) {
      previous = next
      notifyBotsChanged()
    }
  })
}
