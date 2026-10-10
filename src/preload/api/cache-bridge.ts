import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../api-types'

export const cacheApi = {
  getGitHub: () => ipcRenderer.invoke('cache:getGitHub'),
  setGitHub: (args) => ipcRenderer.invoke('cache:setGitHub', args)
} satisfies PreloadApi['cache']
