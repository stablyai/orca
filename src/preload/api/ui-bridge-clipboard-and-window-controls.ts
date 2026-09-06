import { ipcRenderer, webFrame } from 'electron'
import type {
  RuntimeMobileMarkdownRequest,
  RuntimeMobileMarkdownResponse
} from '../../shared/mobile-markdown-document'
import {
  richMarkdownContextMenuCommandChannel,
  richMarkdownContextMenuTargetChannel,
  type RichMarkdownContextMenuCommandPayload,
  type RichMarkdownContextMenuTableTarget
} from '../../shared/rich-markdown-context-menu'
import type { NativeFileDropPayload } from '../../shared/native-file-drop'
import type { ClipboardImageThumbnail } from '../../shared/clipboard-image'
import type { ReadClipboardTextOptions } from '../../shared/clipboard-text'
import { subscribeNativeFileDrop } from '../preload-runtime-support'
import type { PreloadApi } from '../api-types'

export const uiClipboardAndWindowControlsApi = {
  onOpenDiffFromMobile: (
    callback: (data: {
      worktreeId: string
      filePath: string
      relativePath: string
      staged: boolean
      runtimeEnvironmentId?: string
    }) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: {
        worktreeId: string
        filePath: string
        relativePath: string
        staged: boolean
        runtimeEnvironmentId?: string
      }
    ) => callback(data)
    ipcRenderer.on('ui:openDiffFromMobile', listener)
    return () => ipcRenderer.removeListener('ui:openDiffFromMobile', listener)
  },
  onMobileMarkdownRequest: (
    callback: (request: RuntimeMobileMarkdownRequest) => void
  ): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, request: RuntimeMobileMarkdownRequest) =>
      callback(request)
    ipcRenderer.on('ui:mobileMarkdownRequest', listener)
    return () => ipcRenderer.removeListener('ui:mobileMarkdownRequest', listener)
  },
  respondMobileMarkdownRequest: (response: RuntimeMobileMarkdownResponse): void => {
    ipcRenderer.send('ui:mobileMarkdownResponse', response)
  },
  onCloseTerminal: (
    callback: (data: { tabId: string; paneRuntimeId?: number }) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: { tabId: string; paneRuntimeId?: number }
    ) => callback(data)
    ipcRenderer.on('ui:closeTerminal', listener)
    return () => ipcRenderer.removeListener('ui:closeTerminal', listener)
  },
  onTerminalTabCloseRequest: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, request: Parameters<typeof callback>[0]) =>
      callback(request)
    ipcRenderer.on('ui:terminalTabCloseRequest', listener)
    return () => ipcRenderer.removeListener('ui:terminalTabCloseRequest', listener)
  },
  respondTerminalTabClose: (response) => {
    ipcRenderer.send('ui:terminalTabCloseResponse', response)
  },
  onSleepWorktree: (callback: (data: { worktreeId: string }) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: { worktreeId: string }) =>
      callback(data)
    ipcRenderer.on('ui:sleepWorktree', listener)
    return () => ipcRenderer.removeListener('ui:sleepWorktree', listener)
  },
  onResumeSleepingAgents: (callback: (data: { worktreeId: string }) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: { worktreeId: string }) =>
      callback(data)
    ipcRenderer.on('ui:resumeSleepingAgents', listener)
    return () => ipcRenderer.removeListener('ui:resumeSleepingAgents', listener)
  },
  onTerminalZoom: (callback: (direction: 'in' | 'out' | 'reset') => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, direction: 'in' | 'out' | 'reset') =>
      callback(direction)
    ipcRenderer.on('terminal:zoom', listener)
    return () => ipcRenderer.removeListener('terminal:zoom', listener)
  },
  readClipboardText: (options?: ReadClipboardTextOptions): Promise<string> =>
    ipcRenderer.invoke('clipboard:readText', options),
  readSelectionClipboardText: (options?: ReadClipboardTextOptions): Promise<string> =>
    ipcRenderer.invoke('clipboard:readSelectionText', options),
  saveClipboardImageAsTempFile: (args?: {
    connectionId?: string | null
    runtimeEnvironmentId?: string | null
  }): Promise<string | null> => ipcRenderer.invoke('clipboard:saveImageAsTempFile', args),
  readClipboardImageThumbnail: (): Promise<ClipboardImageThumbnail | null> =>
    ipcRenderer.invoke('clipboard:readImageThumbnail'),
  writeClipboardText: (text: string): Promise<void> =>
    ipcRenderer.invoke('clipboard:writeText', text),
  writeTerminalClipboardText: (text: string): Promise<void> =>
    ipcRenderer.invoke('clipboard:writeTerminalText', text),
  writeSelectionClipboardText: (text: string): Promise<void> =>
    ipcRenderer.invoke('clipboard:writeSelectionText', text),
  writeClipboardImage: (dataUrl: string): Promise<void> =>
    ipcRenderer.invoke('clipboard:writeImage', dataUrl),
  performNativePaste: (options?: { mode?: 'paste' | 'paste-and-match-style' }): void => {
    ipcRenderer.send('ui:performNativePaste', {
      mode: options?.mode === 'paste-and-match-style' ? 'paste-and-match-style' : 'paste'
    })
  },
  performNativeSelectionAction: (action: 'copy' | 'select-all'): void => {
    ipcRenderer.send('ui:performNativeSelectionAction', action)
  },
  writeClipboardFile: (
    args:
      | {
          filePath: string
          connectionId?: string | null
        }
      | string
  ): Promise<{ ok: boolean; reason?: string }> => ipcRenderer.invoke('clipboard:writeFile', args),
  onFileDrop: (callback: (data: NativeFileDropPayload) => void): (() => void) =>
    subscribeNativeFileDrop(callback),
  getZoomLevel: (): number => webFrame.getZoomLevel(),
  setZoomLevel: (level: number): void => webFrame.setZoomLevel(level),
  syncTrafficLights: (zoomFactor: number): void =>
    ipcRenderer.send('ui:sync-traffic-lights', zoomFactor),
  setMarkdownEditorFocused: (focused: boolean): void => {
    ipcRenderer.send('ui:setMarkdownEditorFocused', focused)
  },
  setRichMarkdownContextMenuTarget: (target: RichMarkdownContextMenuTableTarget | null): void => {
    ipcRenderer.send(richMarkdownContextMenuTargetChannel, target)
  },
  setTerminalInputFocused: (focused: boolean): void => {
    ipcRenderer.send('ui:setTerminalInputFocused', focused)
  },
  setFloatingFocus: (state: { panelFocused: boolean; terminalFocused: boolean }): void => {
    ipcRenderer.send('ui:setFloatingFocus', state)
  },
  setShortcutRecorderFocused: (focused: boolean): void => {
    ipcRenderer.send('ui:setShortcutRecorderFocused', focused)
  },
  onRichMarkdownContextCommand: (
    callback: (payload: RichMarkdownContextMenuCommandPayload) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      payload: RichMarkdownContextMenuCommandPayload
    ) => callback(payload)
    ipcRenderer.on(richMarkdownContextMenuCommandChannel, listener)
    return () => ipcRenderer.removeListener(richMarkdownContextMenuCommandChannel, listener)
  },
  onFullscreenChanged: (callback: (isFullScreen: boolean) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, isFullScreen: boolean) =>
      callback(isFullScreen)
    ipcRenderer.on('window:fullscreen-changed', listener)
    return () => ipcRenderer.removeListener('window:fullscreen-changed', listener)
  },
  onSystemResumed: (callback: () => void): (() => void) => {
    const listener = () => callback()
    ipcRenderer.on('system:resumed', listener)
    return () => ipcRenderer.removeListener('system:resumed', listener)
  },
  minimize: (): void => {
    ipcRenderer.send('window:minimize')
  },
  maximize: (): void => {
    ipcRenderer.send('window:maximize')
  },
  isMaximized: (): Promise<boolean> => ipcRenderer.invoke('window:isMaximized'),
  onMaximizeChanged: (callback: (isMaximized: boolean) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, isMaximized: boolean) =>
      callback(isMaximized)
    ipcRenderer.on('window:maximize-changed', listener)
    return () => ipcRenderer.removeListener('window:maximize-changed', listener)
  },
  requestClose: (): void => {
    ipcRenderer.send('window:request-close')
  },
  popupMenu: (): void => {
    ipcRenderer.send('menu:popup')
  },
  onWindowCloseRequested: (callback: (data: { isQuitting: boolean }) => void): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: { isQuitting: boolean; requestId?: number }
    ): void => {
      // Why: main cannot reach will-quit while a frozen renderer owns the window close handshake.
      ipcRenderer.send('window:close-request-received', data?.requestId)
      callback({ isQuitting: data?.isQuitting ?? false })
    }
    ipcRenderer.on('window:close-requested', listener)
    return () => ipcRenderer.removeListener('window:close-requested', listener)
  },
  confirmWindowClose: (): void => {
    ipcRenderer.send('window:confirm-close')
  },
  notifyWindowRevealed: (): void => {
    ipcRenderer.send('ui:window-revealed')
  }
} satisfies Partial<PreloadApi['ui']>
