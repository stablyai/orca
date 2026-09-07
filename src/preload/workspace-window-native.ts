import { createShellBridge } from './api/shell-bridge'
import { exposeWorkspaceViewBridge } from './workspace-view-bridge'
import { subscribeWorkspaceWindowBrowser } from './workspace-window-browser-stream'
import { workspaceWindowFileTransfer } from './workspace-window-file-transfer'
import { createRuntimeEnvironmentsBridge } from './api/runtime-environments-bridge'
const WORKSPACE_WINDOW_NATIVE_BRIDGE_KEY = 'orcaWorkspaceWindowNative'
type NativeListener = (event: Electron.IpcRendererEvent, ...args: any[]) => void

// Why: raw require keeps the sandboxed preload standalone in the main-process CJS build.
const { contextBridge, ipcRenderer } = require('electron') as {
  contextBridge: { exposeInMainWorld: (key: string, api: unknown) => void }
  ipcRenderer: {
    invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
    send: (channel: string, ...args: unknown[]) => void
    sendSync: (channel: string, ...args: unknown[]) => { value?: string | null; error?: string }
    on: (channel: string, listener: NativeListener) => void
    removeListener: (channel: string, listener: NativeListener) => void
  }
}

const bridge = {
  presentationStorage: {
    flush: () => ipcRenderer.invoke('workspaceWindow:presentationFlush') as Promise<void>,
    getItem: (key: string) => {
      const result = ipcRenderer.sendSync('workspaceWindow:presentationStorage', key)
      if (result.error) {
        throw new Error(result.error)
      }
      return result.value ?? null
    },
    setItem: (key: string, value: string) => {
      const result = ipcRenderer.sendSync('workspaceWindow:presentationStorage', key, value)
      if (result.error) {
        throw new Error(result.error)
      }
    }
  },
  localRuntimeId:
    process.argv
      .find((arg) => arg.startsWith('--orca-local-runtime-id='))
      ?.slice('--orca-local-runtime-id='.length) ?? '',
  browserInput: (request: unknown) => ipcRenderer.invoke('workspaceWindow:browserInput', request),
  runtimeEnvironments: createRuntimeEnvironmentsBridge({
    invoke: (channel, ...args) => ipcRenderer.invoke(`workspaceWindow:${channel}`, ...args),
    send: (channel, ...args) => ipcRenderer.send(`workspaceWindow:${channel}`, ...args),
    on: (channel, listener) => {
      ipcRenderer.on(channel, listener)
      return ipcRenderer as never
    },
    removeListener: (channel, listener) => {
      ipcRenderer.removeListener(channel, listener)
      return ipcRenderer as never
    }
  }),
  fileTransfer: workspaceWindowFileTransfer,
  subscribeBrowser: subscribeWorkspaceWindowBrowser,
  shell: createShellBridge('workspaceWindow:shell'),
  onMenuEvent: (channel: string, callback: (data?: string) => void) => {
    const channels = [
      'ui:openSettings',
      'ui:openSetupGuide',
      'ui:openFeatureTour',
      'ui:openCrashReport',
      'ui:toggleLeftSidebar',
      'ui:toggleRightSidebar',
      'ui:toggleStatusBar',
      'ui:appMenuPaste',
      'ui:appMenuSelectionAction',
      'terminal:zoom'
    ]
    if (!channels.includes(channel)) {
      throw new Error('workspace_window_menu_channel_unauthorized')
    }
    const listener = (_event: unknown, data?: string): void => callback(data)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  },
  confirmClose: () => ipcRenderer.invoke('workspaceWindow:confirmClose') as Promise<boolean>,
  getWindowId: () => ipcRenderer.invoke('workspaceWindow:getWindowId') as Promise<number>,
  onCloseRequested: (callback: (data: { isQuitting: boolean }) => void) => {
    const listener = (_event: unknown, data: { isQuitting: boolean; requestId: number }): void => {
      void ipcRenderer.invoke('workspaceWindow:closeRequestReceived', data.requestId)
      callback(data)
    }
    ipcRenderer.on('workspaceWindow:closeRequested', listener)
    return () => ipcRenderer.removeListener('workspaceWindow:closeRequested', listener)
  },
  pickDirectory: () => ipcRenderer.invoke('workspaceWindow:pickDirectory'),
  pickFolder: () => ipcRenderer.invoke('workspaceWindow:pickFolder'),
  pickFolders: () => ipcRenderer.invoke('workspaceWindow:pickFolders'),
  requestClose: () => ipcRenderer.invoke('workspaceWindow:requestClose') as Promise<void>
}

contextBridge.exposeInMainWorld(WORKSPACE_WINDOW_NATIVE_BRIDGE_KEY, bridge)
exposeWorkspaceViewBridge(contextBridge, ipcRenderer)
