import { ipcRenderer } from 'electron'
import type { DashboardRevealAgentArgs, DashboardSnapshot } from '../../shared/dashboard-snapshot'
import type { PreloadApi } from '../api-types'

export const dashboardApi = {
  openPopout: (): Promise<void> => ipcRenderer.invoke('dashboardPopout:open'),

  publishSnapshot: (snapshot: DashboardSnapshot): Promise<void> =>
    ipcRenderer.invoke('dashboard:publishSnapshot', snapshot),
  getPopoutOpen: (): Promise<boolean> => ipcRenderer.invoke('dashboard:getPopoutOpen'),
  onPopoutOpenChanged: (callback: (open: boolean) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, open: boolean): void => callback(open)
    ipcRenderer.on('dashboard:popoutOpenChanged', listener)
    return () => ipcRenderer.removeListener('dashboard:popoutOpenChanged', listener)
  },
  onSnapshotRequested: (callback: () => void): (() => void) => {
    const listener = (): void => callback()
    ipcRenderer.on('dashboard:snapshotRequested', listener)
    return () => ipcRenderer.removeListener('dashboard:snapshotRequested', listener)
  },
  onRevealAgent: (callback: (args: DashboardRevealAgentArgs) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, args: DashboardRevealAgentArgs): void =>
      callback(args)
    ipcRenderer.on('ui:revealDashboardAgent', listener)
    return () => ipcRenderer.removeListener('ui:revealDashboardAgent', listener)
  },
  onAckAgent: (callback: (paneKey: string, intent: 'view' | 'explicit') => void): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      ack: { paneKey: string; intent: 'view' | 'explicit' }
    ): void => callback(ack.paneKey, ack.intent)
    ipcRenderer.on('ui:ackDashboardAgent', listener)
    return () => ipcRenderer.removeListener('ui:ackDashboardAgent', listener)
  },

  requestSnapshot: (): Promise<void> => ipcRenderer.invoke('dashboard:requestSnapshot'),
  onSnapshot: (callback: (snapshot: DashboardSnapshot) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, snapshot: DashboardSnapshot): void =>
      callback(snapshot)
    ipcRenderer.on('dashboard:snapshot', listener)
    return () => ipcRenderer.removeListener('dashboard:snapshot', listener)
  },
  revealAgent: (args: DashboardRevealAgentArgs): Promise<void> =>
    ipcRenderer.invoke('dashboardPopout:revealAgent', args),
  ackAgent: (paneKey: string, intent: 'view' | 'explicit'): Promise<void> =>
    ipcRenderer.invoke('dashboardPopout:ackAgent', { paneKey, intent })
} satisfies PreloadApi['dashboard']
