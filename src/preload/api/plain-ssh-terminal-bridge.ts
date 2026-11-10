import { ipcRenderer } from 'electron'
import {
  PLAIN_SSH_TERMINAL_CHANNELS,
  type PlainSshTerminalEvent,
  type PlainSshTerminalOpenResult
} from '../../shared/plain-ssh-terminal'

export type PlainSshTerminalApi = {
  open: (args: {
    targetId: string
    cols: number
    rows: number
  }) => Promise<PlainSshTerminalOpenResult>
  write: (args: { sessionId: string; data: string }) => void
  resize: (args: { sessionId: string; cols: number; rows: number }) => void
  close: (args: { sessionId: string }) => void
  ack: (args: { sessionId: string; chars: number }) => void
  onEvent: (callback: (event: PlainSshTerminalEvent) => void) => () => void
}

export const plainSshTerminalApi: PlainSshTerminalApi = {
  open: (args) => ipcRenderer.invoke(PLAIN_SSH_TERMINAL_CHANNELS.open, args),
  write: (args) => ipcRenderer.send(PLAIN_SSH_TERMINAL_CHANNELS.write, args),
  resize: (args) => ipcRenderer.send(PLAIN_SSH_TERMINAL_CHANNELS.resize, args),
  close: (args) => ipcRenderer.send(PLAIN_SSH_TERMINAL_CHANNELS.close, args),
  ack: (args) => ipcRenderer.send(PLAIN_SSH_TERMINAL_CHANNELS.ack, args),
  onEvent: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: PlainSshTerminalEvent): void =>
      callback(payload)
    ipcRenderer.on(PLAIN_SSH_TERMINAL_CHANNELS.event, listener)
    return () => ipcRenderer.removeListener(PLAIN_SSH_TERMINAL_CHANNELS.event, listener)
  }
}
