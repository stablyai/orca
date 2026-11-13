import { ipcRenderer } from 'electron'
import type {
  SessionTabScrollReply,
  SessionTabScrollRequest
} from '../../../shared/workspace-layout/session-tab-scroll'

export type UiSessionTabScrollApi = {
  onScrollSessionTab: (callback: (data: SessionTabScrollRequest) => void) => () => void
  replySessionTabScroll: (reply: SessionTabScrollReply) => void
}

export const uiSessionTabScrollApi = {
  onScrollSessionTab: (callback: (data: SessionTabScrollRequest) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: SessionTabScrollRequest) =>
      callback(data)
    ipcRenderer.on('ui:scrollSessionTab', listener)
    return () => ipcRenderer.removeListener('ui:scrollSessionTab', listener)
  },
  replySessionTabScroll: (reply: SessionTabScrollReply): void => {
    ipcRenderer.send('ui:sessionTabScrollReply', reply)
  }
} satisfies UiSessionTabScrollApi
