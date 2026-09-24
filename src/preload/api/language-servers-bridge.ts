import { ipcRenderer } from 'electron'
import {
  LANGUAGE_SERVERS_STATUS_CHANNEL,
  type LanguageServerDocumentChange,
  type LanguageServerPosition,
  type LanguageServerStatusEvent
} from '../../shared/language-server-navigation-types'
import type { LanguageServersApi } from './language-servers-api'

export const languageServersApi = {
  openDocument: (args: { worktreeRoot: string; filePath: string; text: string }) =>
    ipcRenderer.invoke('languageServers:openDocument', args),
  changeDocument: (args: {
    filePath: string
    version: number
    changes: readonly LanguageServerDocumentChange[]
  }) => ipcRenderer.invoke('languageServers:changeDocument', args),
  closeDocument: (args: { filePath: string }) =>
    ipcRenderer.invoke('languageServers:closeDocument', args),
  definition: (args: { filePath: string; position: LanguageServerPosition }) =>
    ipcRenderer.invoke('languageServers:definition', args),
  references: (args: { filePath: string; position: LanguageServerPosition }) =>
    ipcRenderer.invoke('languageServers:references', args),
  declaration: (args: { filePath: string; position: LanguageServerPosition }) =>
    ipcRenderer.invoke('languageServers:declaration', args),
  hover: (args: { filePath: string; position: LanguageServerPosition }) =>
    ipcRenderer.invoke('languageServers:hover', args),
  onStatus: (callback: (event: LanguageServerStatusEvent) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: LanguageServerStatusEvent): void =>
      callback(data)
    ipcRenderer.on(LANGUAGE_SERVERS_STATUS_CHANNEL, listener)
    return () => ipcRenderer.removeListener(LANGUAGE_SERVERS_STATUS_CHANNEL, listener)
  }
} satisfies LanguageServersApi
