import type { WorkspaceViewBridge, WorkspaceViewCommand } from '../shared/workspace-view-bridge'
import { subscribeWorkspaceWindowBrowser } from './workspace-window-browser-stream'

export function exposeWorkspaceViewBridge(
  contextBridge: { exposeInMainWorld: (key: string, api: unknown) => void },
  ipcRenderer: {
    invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
    on: (channel: string, listener: (...args: any[]) => void) => unknown
    removeListener: (channel: string, listener: (...args: any[]) => void) => unknown
  }
): void {
  const bridge: WorkspaceViewBridge = {
    undoTransfer: (id) => ipcRenderer.invoke('workspaceViews:undoTransfer', id) as Promise<boolean>,
    monitors: () =>
      ipcRenderer.invoke('workspaceViews:monitors') as ReturnType<WorkspaceViewBridge['monitors']>,
    moveToMonitor: (id) =>
      ipcRenderer.invoke('workspaceViews:moveToMonitor', id) as Promise<boolean>,
    bringWindowsToMonitor: () =>
      ipcRenderer.invoke('workspaceViews:bringWindowsToMonitor') as Promise<void>,
    showMonitorMenu: () => ipcRenderer.invoke('workspaceViews:showMonitorMenu') as Promise<void>,
    reopenWindow: () => ipcRenderer.invoke('workspaceViews:reopenWindow') as Promise<number>,
    discover: () =>
      ipcRenderer.invoke('workspaceViews:discover') as ReturnType<WorkspaceViewBridge['discover']>,
    visit: (location) => ipcRenderer.invoke('workspaceViews:visit', location) as Promise<boolean>,
    open: (location, target) =>
      ipcRenderer.invoke('workspaceViews:open', location, target) as Promise<boolean>,
    createWindow: () => ipcRenderer.invoke('workspaceViews:createWindow') as Promise<number>,
    locateDrop: (point) =>
      ipcRenderer.invoke('workspaceViews:locateDrop', point) as ReturnType<
        WorkspaceViewBridge['locateDrop']
      >,
    ready: () => ipcRenderer.invoke('workspaceViews:ready') as Promise<number>,
    subscribeBrowser: subscribeWorkspaceWindowBrowser,
    registerViews: (views) => ipcRenderer.invoke('workspaceViews:register', views) as Promise<void>,
    claim: (key, viewId) =>
      ipcRenderer.invoke('workspaceViews:claim', key, viewId) as Promise<boolean>,
    list: () =>
      ipcRenderer.invoke('workspaceViews:list') as ReturnType<WorkspaceViewBridge['list']>,
    transfer: (request) =>
      ipcRenderer.invoke('workspaceViews:transfer', request) as Promise<boolean>,
    onRequest: (callback) => {
      const listener = async (
        _event: unknown,
        id: string,
        operation: WorkspaceViewCommand,
        payload: unknown
      ): Promise<void> => {
        let result: unknown
        try {
          result = { ok: true, value: await callback(operation, payload) }
        } catch (error) {
          result = { ok: false, error: String(error) }
        }
        await ipcRenderer.invoke('workspaceViews:reply', id, result)
      }
      ipcRenderer.on('workspaceViews:request', listener)
      return () => {
        ipcRenderer.removeListener('workspaceViews:request', listener)
      }
    }
  }
  contextBridge.exposeInMainWorld('orcaWorkspaceViews', bridge)
}
