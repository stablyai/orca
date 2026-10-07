import { ipcRenderer } from 'electron'
import type { TerminalPaneSplitSource } from '../../shared/feature-education-telemetry'
import type { TerminalTabCreateReply } from '../../shared/terminal-reveal-identity'
import type {
  AgentLaunchTabPublishReply,
  AgentLaunchTabPublishRequest
} from '../../shared/agent-launch-tab-publication'
import type { AgentLaunchPaneVerdictEvent } from '../../shared/agent-launch-pane-verdict'
import type {
  AgentProviderSessionMetadata,
  SleepingAgentLaunchConfig
} from '../../shared/agent-session-resume'
import type { TuiAgent } from '../../shared/tui-agent'
import type { RuntimeNavigationTarget } from '../../shared/runtime-navigation'
import type {
  RuntimeMobileSessionTabMove,
  RuntimeTerminalCreateRequestPayload,
  RuntimeTerminalPresentation
} from '../../shared/runtime-types'
import type { PreloadApi } from '../api-types'

export const uiTerminalAndSessionTabsApi = {
  onCreateTerminal: (
    callback: (data: {
      requestId?: string
      worktreeId: string
      command?: string
      cwd?: string
      env?: Record<string, string>
      launchConfig?: SleepingAgentLaunchConfig
      resumeProviderSession?: AgentProviderSessionMetadata
      launchToken?: string
      launchAgent?: TuiAgent
      viewMode?: 'terminal' | 'chat'
      title?: string
      ptyId?: string
      activate?: boolean
      focus?: boolean
      presentation?: RuntimeTerminalPresentation
      surfaceOwner?: false
      tabId?: string
      leafId?: string
      splitFromLeafId?: string
      splitDirection?: 'horizontal' | 'vertical'
      splitTelemetrySource?: TerminalPaneSplitSource
    }) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: {
        requestId?: string
        worktreeId: string
        command?: string
        cwd?: string
        env?: Record<string, string>
        launchConfig?: SleepingAgentLaunchConfig
        resumeProviderSession?: AgentProviderSessionMetadata
        launchToken?: string
        launchAgent?: TuiAgent
        viewMode?: 'terminal' | 'chat'
        title?: string
        ptyId?: string
        activate?: boolean
        focus?: boolean
        presentation?: RuntimeTerminalPresentation
        surfaceOwner?: false
        tabId?: string
        leafId?: string
        splitFromLeafId?: string
        splitDirection?: 'horizontal' | 'vertical'
        splitTelemetrySource?: TerminalPaneSplitSource
      }
    ) => callback(data)
    ipcRenderer.on('ui:createTerminal', listener)
    return () => ipcRenderer.removeListener('ui:createTerminal', listener)
  },
  onRequestTerminalCreate: (
    callback: (data: RuntimeTerminalCreateRequestPayload) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: RuntimeTerminalCreateRequestPayload
    ) => callback(data)
    ipcRenderer.on('terminal:requestTabCreate', listener)
    return () => ipcRenderer.removeListener('terminal:requestTabCreate', listener)
  },
  onRequestTerminalTabMount: (
    callback: (data: { worktreeId: string; tabId?: string; ptyId?: string }) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: { worktreeId: string; tabId?: string; ptyId?: string }
    ) => callback(data)
    ipcRenderer.on('terminal:requestTabMount', listener)
    return () => ipcRenderer.removeListener('terminal:requestTabMount', listener)
  },
  replyTerminalCreate: (reply: TerminalTabCreateReply): void => {
    ipcRenderer.send('terminal:tabCreateReply', reply)
  },
  onPublishAgentLaunchTab: (
    callback: (data: AgentLaunchTabPublishRequest) => void
  ): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: AgentLaunchTabPublishRequest) =>
      callback(data)
    ipcRenderer.on('ui:publishAgentLaunchTab', listener)
    return () => ipcRenderer.removeListener('ui:publishAgentLaunchTab', listener)
  },
  replyAgentLaunchTabPublish: (reply: AgentLaunchTabPublishReply): void => {
    ipcRenderer.send('agentLaunch:tabPublishReply', reply)
  },
  onAgentLaunchPaneVerdict: (
    callback: (data: AgentLaunchPaneVerdictEvent) => void
  ): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: AgentLaunchPaneVerdictEvent) =>
      callback(data)
    ipcRenderer.on('ui:agentLaunchPaneVerdict', listener)
    return () => ipcRenderer.removeListener('ui:agentLaunchPaneVerdict', listener)
  },
  onSplitTerminal: (
    callback: (data: {
      tabId: string
      paneRuntimeId: number
      direction: 'horizontal' | 'vertical'
      command?: string
      worktreeId?: string
      sourceLeafId?: string
      telemetrySource?: TerminalPaneSplitSource
      newLeafId?: string
    }) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: {
        tabId: string
        paneRuntimeId: number
        direction: 'horizontal' | 'vertical'
        command?: string
        worktreeId?: string
        sourceLeafId?: string
        telemetrySource?: TerminalPaneSplitSource
        newLeafId?: string
      }
    ) => callback(data)
    ipcRenderer.on('ui:splitTerminal', listener)
    return () => ipcRenderer.removeListener('ui:splitTerminal', listener)
  },
  onRenameTerminal: (
    callback: (data: { tabId: string; title: string | null; recordInteraction?: false }) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: { tabId: string; title: string | null; recordInteraction?: false }
    ) => callback(data)
    ipcRenderer.on('ui:renameTerminal', listener)
    return () => ipcRenderer.removeListener('ui:renameTerminal', listener)
  },
  onFocusTerminal: (
    callback: (data: {
      tabId: string
      worktreeId: string
      leafId?: string | null
      ackPaneKeyOnSuccess?: string
      flashFocusedPane?: boolean
      scrollToBottomIfOutputSinceLastView?: boolean
    }) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: {
        tabId: string
        worktreeId: string
        leafId?: string | null
        ackPaneKeyOnSuccess?: string
        flashFocusedPane?: boolean
        scrollToBottomIfOutputSinceLastView?: boolean
      }
    ) => callback(data)
    ipcRenderer.on('ui:focusTerminal', listener)
    return () => ipcRenderer.removeListener('ui:focusTerminal', listener)
  },
  onFocusEditorTab: (
    callback: (data: {
      tabId: string
      worktreeId: string
      /** The user clicked a notification, so revealing the tab is navigation and not a courtesy. */
      userInitiated?: boolean
    }) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: { tabId: string; worktreeId: string; userInitiated?: boolean }
    ) => callback(data)
    ipcRenderer.on('ui:focusEditorTab', listener)
    return () => ipcRenderer.removeListener('ui:focusEditorTab', listener)
  },
  onCloseSessionTab: (
    callback: (data: { tabId: string; worktreeId: string }) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: { tabId: string; worktreeId: string }
    ) => callback(data)
    ipcRenderer.on('ui:closeSessionTab', listener)
    return () => ipcRenderer.removeListener('ui:closeSessionTab', listener)
  },
  onSessionTabCloseRequest: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, request: Parameters<typeof callback>[0]) =>
      callback(request)
    ipcRenderer.on('ui:sessionTabCloseRequest', listener)
    return () => ipcRenderer.removeListener('ui:sessionTabCloseRequest', listener)
  },
  respondSessionTabClose: (response) => {
    ipcRenderer.send('ui:sessionTabCloseResponse', response)
  },
  onMoveSessionTab: (
    callback: (data: { worktreeId: string } & RuntimeMobileSessionTabMove) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: { worktreeId: string } & RuntimeMobileSessionTabMove
    ) => callback(data)
    ipcRenderer.on('ui:moveSessionTab', listener)
    return () => ipcRenderer.removeListener('ui:moveSessionTab', listener)
  },
  onSetSessionTabProps: (
    callback: (data: {
      requestId: string
      worktreeId: string
      tabId: string
      color?: string | null
      isPinned?: boolean
      viewMode?: 'terminal' | 'chat'
    }) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: {
        requestId: string
        worktreeId: string
        tabId: string
        color?: string | null
        isPinned?: boolean
        viewMode?: 'terminal' | 'chat'
      }
    ) => callback(data)
    ipcRenderer.on('ui:sessionTabPropsRequest', listener)
    return () => ipcRenderer.removeListener('ui:sessionTabPropsRequest', listener)
  },
  respondSessionTabProps: (response: { requestId: string; error?: string }): void => {
    ipcRenderer.send('ui:sessionTabPropsResponse', response)
  },
  onOpenFileFromMobile: (
    callback: (data: {
      worktreeId: string
      filePath: string
      relativePath: string
      runtimeEnvironmentId?: string
      navigation?: RuntimeNavigationTarget
    }) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: {
        worktreeId: string
        filePath: string
        relativePath: string
        runtimeEnvironmentId?: string
        navigation?: RuntimeNavigationTarget
      }
    ) => callback(data)
    ipcRenderer.on('ui:openFileFromMobile', listener)
    return () => ipcRenderer.removeListener('ui:openFileFromMobile', listener)
  }
} satisfies Partial<PreloadApi['ui']>
