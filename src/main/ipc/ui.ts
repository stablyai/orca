import { normalizeJiraQuickFilterState } from '../../shared/jira/jira-quick-filters'
import { JiraQuickFilterStateParam } from '../../shared/rpc-contract/jira-quick-filter-params'
import {
  normalizeJiraSavedFilterState,
  mutateJiraSavedFilterState
} from '../../shared/jira/jira-saved-filters'
import { JiraSavedFilterMutationParam } from '../../shared/rpc-contract/jira-saved-filter-params'
import { BrowserWindow, ipcMain, webContents, type WebContents } from 'electron'
import type { Store } from '../persistence'
import type { PersistedUIState } from '../../shared/persisted-ui-state-types'
import { isFeatureInteractionId } from '../../shared/feature-interactions'
import { isWslMoveWindowWriteHeld } from '../persistence/moving-wsl-projects/wsl-move-window-write-hold'
import { isTrustedMainRendererSender } from './main-renderer-sender-trust'

let trustedUIRendererWebContentsId: number | null = null

export function setTrustedUIRendererWebContentsId(webContentsId: number | null): void {
  trustedUIRendererWebContentsId = webContentsId
}

export function clearTrustedUIRendererWebContentsId(webContentsId: number): void {
  if (trustedUIRendererWebContentsId === webContentsId) {
    trustedUIRendererWebContentsId = null
  }
}

export function sendToTrustedUIRenderer(
  channel: string,
  payload: unknown,
  excludedWebContentsId?: number
): void {
  const renderer = getTrustedUIRendererWebContents(excludedWebContentsId)
  renderer?.send(channel, payload)
}

export function getTrustedUIRendererWebContents(
  excludedWebContentsId?: number
): WebContents | null {
  // Target only trusted app UI; retained browser/utility windows cannot consume these events.
  const rendererId = trustedUIRendererWebContentsId
  if (rendererId == null || rendererId === excludedWebContentsId) {
    return null
  }
  const renderer = webContents.fromId(rendererId)
  if (!renderer || renderer.isDestroyed()) {
    return null
  }
  return renderer
}

export function getTrustedUIRendererWindow(): BrowserWindow | null {
  const renderer = getTrustedUIRendererWebContents()
  return renderer ? BrowserWindow.fromWebContents(renderer) : null
}

export function registerUIHandlers(
  store: Store,
  options: { isDashboardPopoutRenderer?: (sender: WebContents) => boolean } = {}
): void {
  store.onUIChanged((ui) => sendToTrustedUIRenderer('ui:stateChanged', ui))

  ipcMain.handle('ui:getJiraQuickFilters', () =>
    normalizeJiraQuickFilterState(store.getUI().jiraQuickFilterState)
  )
  ipcMain.handle('ui:setJiraQuickFilters', (_event, input: unknown) => {
    const state = normalizeJiraQuickFilterState(JiraQuickFilterStateParam.parse(input))
    store.updateUI({ jiraQuickFilterState: state })
    return state
  })
  ipcMain.handle('ui:getJiraSavedFilters', () =>
    normalizeJiraSavedFilterState(store.getUI().jiraSavedFilterState)
  )
  ipcMain.handle('ui:mutateJiraSavedFilters', (_event, input: unknown) => {
    const mutation = JiraSavedFilterMutationParam.parse(input)
    const state = mutateJiraSavedFilterState(store.getUI().jiraSavedFilterState, mutation)
    store.updateUI({ jiraSavedFilterState: state })
    return state
  })
  ipcMain.handle('ui:get', () => {
    return store.getUI()
  })

  ipcMain.handle('ui:set', (_event, args: Partial<PersistedUIState>) => {
    // A window a WSL move rewrote under is stale until main reloads it.
    if (!isWslMoveWindowWriteHeld()) {
      store.updateUI(args)
    }
  })

  ipcMain.handle('ui:recordFeatureInteraction', (_event, id: unknown) => {
    if (!isFeatureInteractionId(id)) {
      throw new Error('invalid_feature_interaction_id')
    }
    return store.recordFeatureInteraction(id)
  })

  ipcMain.removeAllListeners('ui:performNativePaste')
  ipcMain.on('ui:performNativePaste', (event, options?: { mode?: unknown }) => {
    if (!isTrustedUIRenderer(event.sender)) {
      return
    }
    // Unclaimed app-menu paste falls back only to the requesting window.
    const webContents = BrowserWindow.fromWebContents(event.sender)?.webContents
    if (options?.mode === 'paste-and-match-style') {
      webContents?.pasteAndMatchStyle()
      return
    }
    webContents?.paste()
  })

  ipcMain.removeAllListeners('ui:performNativeSelectionAction')
  ipcMain.on('ui:performNativeSelectionAction', (event, action: unknown) => {
    if (
      !isTrustedUIRenderer(event.sender) &&
      options.isDashboardPopoutRenderer?.(event.sender) !== true
    ) {
      return
    }
    const target = BrowserWindow.fromWebContents(event.sender)?.webContents
    if (action === 'copy') {
      target?.copy()
    } else if (action === 'select-all') {
      target?.selectAll()
    }
  })
}

export function isTrustedUIRenderer(sender: WebContents): boolean {
  return isTrustedMainRendererSender(sender, trustedUIRendererWebContentsId)
}
