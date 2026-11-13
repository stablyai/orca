import { ipcRenderer } from 'electron'
import {
  FLOATING_WORKSPACE_WINDOW_CHANNELS as CHANNELS,
  type FloatingWorkspaceWindowSnapshot
} from '../../../shared/floating-workspace-window'
import type { PreloadApi } from '../../api-types'

function subscribe<Args extends unknown[]>(
  channel: string,
  callback: (...args: Args) => void
): () => void {
  const listener = (_event: Electron.IpcRendererEvent, ...args: Args): void => callback(...args)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

export const floatingWorkspaceWindowApi = {
  show: (options: { focus: boolean }): Promise<void> =>
    ipcRenderer.invoke(CHANNELS.show, { focus: options.focus }),
  hide: (): Promise<void> => ipcRenderer.invoke(CHANNELS.hide),
  destroy: (): Promise<void> => ipcRenderer.invoke(CHANNELS.destroy),
  publishSnapshot: (snapshot: FloatingWorkspaceWindowSnapshot): void =>
    ipcRenderer.send(CHANNELS.publishSnapshot, snapshot),
  requestSnapshot: (): Promise<FloatingWorkspaceWindowSnapshot | null> =>
    ipcRenderer.invoke(CHANNELS.requestSnapshot),
  requestDock: (): void => ipcRenderer.send(CHANNELS.requestDock),
  ackAgent: (paneKey: string, intent: 'view' | 'explicit'): void =>
    ipcRenderer.send(CHANNELS.ackAgent, { paneKey, intent }),
  onSnapshot: (callback: (snapshot: FloatingWorkspaceWindowSnapshot) => void): (() => void) =>
    subscribe(CHANNELS.snapshot, callback),
  onSnapshotRequested: (callback: () => void): (() => void) =>
    subscribe(CHANNELS.snapshotRequested, () => callback()),
  onDockRequested: (callback: () => void): (() => void) =>
    subscribe(CHANNELS.dockRequested, () => callback()),
  onHiddenByUser: (callback: () => void): (() => void) =>
    subscribe(CHANNELS.hiddenByUser, () => callback()),
  onAgentAcked: (callback: (paneKey: string, intent: 'view' | 'explicit') => void): (() => void) =>
    subscribe(CHANNELS.agentAcked, (ack: { paneKey: string; intent: 'view' | 'explicit' }) =>
      callback(ack.paneKey, ack.intent)
    )
} satisfies PreloadApi['floatingWorkspaceWindow']
