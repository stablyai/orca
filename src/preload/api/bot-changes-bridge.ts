import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../api-types'
import { readBotChangeScopeWithItems } from '../../shared/bots/bot-change-scope'

export const botChangesApi = {
  onChanged: (callback) => {
    const listener = (_event: unknown, scope?: unknown): void =>
      callback(readBotChangeScopeWithItems(scope))
    ipcRenderer.on('bots:changed', listener)
    return () => ipcRenderer.removeListener('bots:changed', listener)
  }
} satisfies PreloadApi['botChanges']
