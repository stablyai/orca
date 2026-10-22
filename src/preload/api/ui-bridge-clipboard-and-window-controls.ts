import type { AgentSessionAttachmentClipboardTarget } from '../../shared/agent-session-attachments'
import { ipcRenderer, webFrame } from 'electron'
import {
  richMarkdownContextMenuCommandChannel,
  richMarkdownContextMenuTargetChannel,
  type RichMarkdownContextMenuCommandPayload,
  type RichMarkdownContextMenuTableTarget
} from '../../shared/rich-markdown-context-menu'
import type { RuntimeNavigationTarget } from '../../shared/runtime-navigation'
import type { TerminalSurfaceCloseTarget } from '../../shared/terminal-surface-close-target'
import type { ClipboardImageThumbnail } from '../../shared/clipboard-image'
import type { ReadClipboardTextOptions } from '../../shared/clipboard-text'
import type { PreloadApi } from '../api-types'

export const uiClipboardAndWindowControlsApi = {
  onOpenDiffFromMobile: (
    callback: (data: {
      worktreeId: string
      filePath: string
      relativePath: string
      staged: boolean
      runtimeEnvironmentId?: string | null
      navigation?: RuntimeNavigationTarget
    }) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: {
        worktreeId: string
        filePath: string
        relativePath: string
        staged: boolean
        runtimeEnvironmentId?: string | null
        navigation?: RuntimeNavigationTarget
      }
    ) => callback(data)
    ipcRenderer.on('ui:openDiffFromMobile', listener)
    return () => ipcRenderer.removeListener('ui:openDiffFromMobile', listener)
  },
  onCloseTerminal: (callback: (target: TerminalSurfaceCloseTarget) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, target: TerminalSurfaceCloseTarget) =>
      callback(target)
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
  onWorktreeSleepRequest: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, request: Parameters<typeof callback>[0]) =>
      callback(request)
    ipcRenderer.on('ui:worktreeSleepRequest', listener)
    return () => ipcRenderer.removeListener('ui:worktreeSleepRequest', listener)
  },
  respondWorktreeSleep: (response) => {
    ipcRenderer.send('ui:worktreeSleepResponse', response)
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
    agentSessionAttachment?: AgentSessionAttachmentClipboardTarget
    /** A native-chat composer paste, kept where its draft can bring it back. */
    forNativeChatDraft?: boolean
    /** With `forNativeChatDraft`: a structured chat on this machine, whose sends claim its pastes. */
    forStructuredChat?: boolean
  }): Promise<string | null> => ipcRenderer.invoke('clipboard:saveImageAsTempFile', args),
  savePastedTextAsFile: (args: {
    text: string
    runtimeEnvironmentId?: string | null
    agentSessionAttachment?: AgentSessionAttachmentClipboardTarget
  }): Promise<string> => ipcRenderer.invoke('clipboard:savePastedTextAsFile', args),
  clipboardHasImage: (): Promise<boolean> => ipcRenderer.invoke('clipboard:hasImage'),
  readClipboardFilePaths: (): Promise<string[]> => ipcRenderer.invoke('clipboard:readFilePaths'),
  restoreNativeChatPastes: (
    paths: string[]
  ): Promise<{ path: string; kept: boolean; exists: boolean }[]> =>
    ipcRenderer.invoke('clipboard:restoreNativeChatPastes', paths),
  onAgentSessionUploadRemoved: (callback: (uploadDir: string) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, uploadDir: string): void =>
      callback(uploadDir)
    ipcRenderer.on('app:agentSessionUploadRemoved', listener)
    return () => ipcRenderer.removeListener('app:agentSessionUploadRemoved', listener)
  },
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
