import { ipcRenderer } from 'electron'
import { admitCloseActiveTabPayload } from '../close-active-tab-payload-admission'
import type { CloseActiveTabPayload } from '../api/ui-command-event-api'
import type {
  WorktreeDefaultTabsLaunch,
  WorktreeSetupLaunch
} from '../../shared/worktree/launch-types'
import { browserFindSubscriptions } from '../preload-runtime-support'
import type { PreloadApi } from '../api-types'

export const uiTabAndBrowserCommandsApi = {
  onRequestTabSetProfile: (
    callback: (data: {
      requestId: string
      browserPageId: string
      profileId: string
      sessionPartition?: string
    }) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: {
        requestId: string
        browserPageId: string
        profileId: string
        sessionPartition?: string
      }
    ) => callback(data)
    ipcRenderer.on('browser:requestTabSetProfile', listener)
    return () => ipcRenderer.removeListener('browser:requestTabSetProfile', listener)
  },
  replyTabSetProfile: (reply: { requestId: string; error?: string }): void => {
    ipcRenderer.send('browser:tabSetProfileReply', reply)
  },
  onRequestTabClose: (
    callback: (data: { requestId: string; tabId: string | null; worktreeId?: string }) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: { requestId: string; tabId: string | null; worktreeId?: string }
    ) => callback(data)
    ipcRenderer.on('browser:requestTabClose', listener)
    return () => ipcRenderer.removeListener('browser:requestTabClose', listener)
  },
  replyTabClose: (reply: {
    requestId: string
    error?: string
    code?: 'browser_tab_not_found'
  }): void => {
    ipcRenderer.send('browser:tabCloseReply', reply)
  },
  onNewTerminalTab: (callback: () => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent) => callback()
    ipcRenderer.on('ui:newTerminalTab', listener)
    return () => ipcRenderer.removeListener('ui:newTerminalTab', listener)
  },
  onFocusBrowserAddressBar: (callback: () => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent) => callback()
    ipcRenderer.on('ui:focusBrowserAddressBar', listener)
    return () => ipcRenderer.removeListener('ui:focusBrowserAddressBar', listener)
  },
  onFindInBrowserPage: browserFindSubscriptions.subscribe,
  onReloadBrowserPage: (callback: () => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent) => callback()
    ipcRenderer.on('ui:reloadBrowserPage', listener)
    return () => ipcRenderer.removeListener('ui:reloadBrowserPage', listener)
  },
  onBrowserHistoryNavigate: (callback: (direction: 'back' | 'forward') => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, direction: 'back' | 'forward'): void =>
      callback(direction)
    ipcRenderer.on('ui:browserHistoryNavigate', listener)
    return () => ipcRenderer.removeListener('ui:browserHistoryNavigate', listener)
  },
  onZoomBrowserPage: (callback: (direction: 'in' | 'out' | 'reset') => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, direction: 'in' | 'out' | 'reset') =>
      callback(direction)
    ipcRenderer.on('ui:zoomBrowserPage', listener)
    return () => ipcRenderer.removeListener('ui:zoomBrowserPage', listener)
  },
  onScrollBrowserPage: (
    callback: (event: { browserPageId: string; deltaX: number; deltaY: number }) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      payload: { browserPageId: string; deltaX: number; deltaY: number }
    ) => callback(payload)
    ipcRenderer.on('ui:scrollBrowserPage', listener)
    return () => ipcRenderer.removeListener('ui:scrollBrowserPage', listener)
  },
  onHardReloadBrowserPage: (callback: () => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent) => callback()
    ipcRenderer.on('ui:hardReloadBrowserPage', listener)
    return () => ipcRenderer.removeListener('ui:hardReloadBrowserPage', listener)
  },
  onCloseActiveTab: (callback: (payload?: CloseActiveTabPayload) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload?: unknown): void => {
      const admitted = admitCloseActiveTabPayload(payload)
      if (admitted.kind === 'legacy') {
        callback()
      } else if (admitted.kind === 'source') {
        callback(admitted.payload)
      }
    }
    ipcRenderer.on('ui:closeActiveTab', listener)
    return () => ipcRenderer.removeListener('ui:closeActiveTab', listener)
  },
  onCloseFloatingItem: (callback: (payload: { sourceId: string }) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: { sourceId: string }) =>
      callback(payload)
    ipcRenderer.on('ui:closeFloatingItem', listener)
    return () => ipcRenderer.removeListener('ui:closeFloatingItem', listener)
  },
  onSelectFloatingIndex: (callback: (payload: { index: number }) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: { index: number }) =>
      callback(payload)
    ipcRenderer.on('ui:selectFloatingIndex', listener)
    return () => ipcRenderer.removeListener('ui:selectFloatingIndex', listener)
  },
  onSwitchTab: (callback: (direction: 1 | -1) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, direction: 1 | -1) => callback(direction)
    ipcRenderer.on('ui:switchTab', listener)
    return () => ipcRenderer.removeListener('ui:switchTab', listener)
  },
  onSwitchTabAcrossAllTypes: (callback: (direction: 1 | -1) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, direction: 1 | -1) => callback(direction)
    ipcRenderer.on('ui:switchTabAcrossAllTypes', listener)
    return () => ipcRenderer.removeListener('ui:switchTabAcrossAllTypes', listener)
  },
  onSwitchRecentTab: (callback: () => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent) => callback()
    ipcRenderer.on('ui:switchRecentTab', listener)
    return () => ipcRenderer.removeListener('ui:switchRecentTab', listener)
  },
  onSwitchTerminalTab: (callback: (direction: 1 | -1) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, direction: 1 | -1) => callback(direction)
    ipcRenderer.on('ui:switchTerminalTab', listener)
    return () => ipcRenderer.removeListener('ui:switchTerminalTab', listener)
  },
  onCtrlTabKeyDown: (callback: (data: { shiftKey: boolean }) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: { shiftKey: boolean }) =>
      callback(data)
    ipcRenderer.on('ui:ctrlTabKeyDown', listener)
    return () => ipcRenderer.removeListener('ui:ctrlTabKeyDown', listener)
  },
  onCtrlTabKeyUp: (callback: () => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent) => callback()
    ipcRenderer.on('ui:ctrlTabKeyUp', listener)
    return () => ipcRenderer.removeListener('ui:ctrlTabKeyUp', listener)
  },
  onToggleStatusBar: (callback: () => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent) => callback()
    ipcRenderer.on('ui:toggleStatusBar', listener)
    return () => ipcRenderer.removeListener('ui:toggleStatusBar', listener)
  },
  onExportPdfRequested: (callback: () => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent) => callback()
    ipcRenderer.on('export:requestPdf', listener)
    return () => ipcRenderer.removeListener('export:requestPdf', listener)
  },
  onAppMenuPaste: (callback: () => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent) => callback()
    ipcRenderer.on('ui:appMenuPaste', listener)
    return () => ipcRenderer.removeListener('ui:appMenuPaste', listener)
  },
  onAppMenuSelectionAction: (callback: (action: 'copy' | 'select-all') => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, action: 'copy' | 'select-all'): void =>
      callback(action)
    ipcRenderer.on('ui:appMenuSelectionAction', listener)
    return () => ipcRenderer.removeListener('ui:appMenuSelectionAction', listener)
  },
  onEditableContextPaste: (callback: (data: { plainTextOnly: boolean }) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: { plainTextOnly: boolean }): void =>
      callback({ plainTextOnly: data?.plainTextOnly === true })
    ipcRenderer.on('ui:editableContextPaste', listener)
    return () => ipcRenderer.removeListener('ui:editableContextPaste', listener)
  },
  onDictationKeyDown: (callback: () => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent) => callback()
    ipcRenderer.on('ui:dictationKeyDown', listener)
    return () => ipcRenderer.removeListener('ui:dictationKeyDown', listener)
  },
  onActivateWorktree: (
    callback: (data: {
      repoId: string
      worktreeId: string
      setup?: WorktreeSetupLaunch
      startup?: { command: string; env?: Record<string, string> }
      defaultTabs?: WorktreeDefaultTabsLaunch
    }) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: {
        repoId: string
        worktreeId: string
        setup?: WorktreeSetupLaunch
        startup?: { command: string; env?: Record<string, string> }
        defaultTabs?: WorktreeDefaultTabsLaunch
      }
    ) => callback(data)
    ipcRenderer.on('ui:activateWorktree', listener)
    return () => ipcRenderer.removeListener('ui:activateWorktree', listener)
  }
} satisfies Partial<PreloadApi['ui']>
