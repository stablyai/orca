import { ipcRenderer } from 'electron'
import type { BrowserPasswordsApi } from './browser-passwords-api'

function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, payload: T): void => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

export const browserPasswordsApi: BrowserPasswordsApi = {
  getStatus: (args) => ipcRenderer.invoke('browserPasswords:getStatus', args),
  list: (args) => ipcRenderer.invoke('browserPasswords:list', args),
  getEntryDetails: (args) => ipcRenderer.invoke('browserPasswords:getEntryDetails', args),
  addEntry: (args) => ipcRenderer.invoke('browserPasswords:addEntry', args),
  updateEntry: (args) => ipcRenderer.invoke('browserPasswords:updateEntry', args),
  deleteAll: (args) => ipcRenderer.invoke('browserPasswords:deleteAll', args),
  copyPassword: (args) => ipcRenderer.invoke('browserPasswords:copyPassword', args),
  deleteEntry: (args) => ipcRenderer.invoke('browserPasswords:deleteEntry', args),
  listNever: (args) => ipcRenderer.invoke('browserPasswords:listNever', args),
  removeNever: (args) => ipcRenderer.invoke('browserPasswords:removeNever', args),
  importCsv: (args) => ipcRenderer.invoke('browserPasswords:importCsv', args),
  importFromBrowser: (args) => ipcRenderer.invoke('browserPasswords:importFromBrowser', args),
  respondSavePrompt: (response) =>
    ipcRenderer.invoke('browserPasswords:respondSavePrompt', response),
  fillLogin: (args) => ipcRenderer.invoke('browserPasswords:fill', args),
  onSavePrompt: (callback) => subscribe('browserPasswords:savePrompt', callback),
  onSavePromptClosed: (callback) => subscribe('browserPasswords:savePromptClosed', callback),
  onFieldFocus: (callback) => subscribe('browserPasswords:fieldFocus', callback),
  onFieldBlur: (callback) => subscribe('browserPasswords:fieldBlur', callback)
}
