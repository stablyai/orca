import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../api-types'
import { readBotChangeScope } from '../../shared/bots/bot-change-scope'

export const botChangesApi = {
  onChanged: (callback) => {
    const listener = (_event: unknown, scope?: unknown): void => callback(readBotChangeScope(scope))
    ipcRenderer.on('bots:changed', listener)
    return () => ipcRenderer.removeListener('bots:changed', listener)
  }
} satisfies PreloadApi['botChanges']
