/**
 * Terminals an older Orca's relay still runs, reached through main's legacy relay bridge.
 * COMPAT(legacy-relay-bridge): revisit 2027-01-15. Desktop-only; web clients leave it undefined.
 */
import { ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  LEGACY_RELAY_BRIDGE_CHANNELS as CHANNELS,
  type LegacyRelayBridgeAttachResult,
  type LegacyRelayBridgeCloseResult,
  type LegacyRelayBridgedPane
} from '../../shared/legacy-relay-bridge-contract'

export type LegacyRelayBridgeApi = {
  listPanes: () => Promise<LegacyRelayBridgedPane[]>
  /** `replayInStream`: the screen arrives as an `onReplay` in output order, and the reply's is empty. */
  attach: (args: {
    ptyId: string
    replayInStream?: boolean
  }) => Promise<LegacyRelayBridgeAttachResult>
  write: (args: { ptyId: string; data: string }) => void
  resize: (args: { ptyId: string; cols: number; rows: number }) => void
  detach: (args: { ptyId: string; acquisitionId: number }) => void
  close: (args: { ptyId: string }) => Promise<LegacyRelayBridgeCloseResult>
  setOutputPaused: (args: { ptyId: string; paused: boolean }) => void
  onPanes: (callback: (panes: LegacyRelayBridgedPane[]) => void) => () => void
  onData: (callback: (event: { ptyId: string; data: string }) => void) => () => void
  onReplay: (callback: (event: { ptyId: string; replay: string }) => void) => () => void
  onExit: (callback: (event: { ptyId: string; code: number }) => void) => () => void
}

function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, payload: T): void => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

export const legacyRelayBridgeApi: LegacyRelayBridgeApi = {
  listPanes: () => ipcRenderer.invoke(CHANNELS.listPanes),
  attach: (args) => ipcRenderer.invoke(CHANNELS.attach, args),
  write: (args) => ipcRenderer.send(CHANNELS.write, args),
  resize: (args) => ipcRenderer.send(CHANNELS.resize, args),
  detach: (args) => ipcRenderer.send(CHANNELS.detach, args),
  close: (args) => ipcRenderer.invoke(CHANNELS.close, args),
  setOutputPaused: (args) => ipcRenderer.send(CHANNELS.setOutputPaused, args),
  onPanes: (callback) => subscribe(CHANNELS.panes, callback),
  onData: (callback) => subscribe(CHANNELS.data, callback),
  onReplay: (callback) => subscribe(CHANNELS.replay, callback),
  onExit: (callback) => subscribe(CHANNELS.exit, callback)
}
