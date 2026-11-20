import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../api-types'

export const avatarGenerationApi = {
  capability: () => ipcRenderer.invoke('avatarGeneration:capability'),
  generate: (args) => ipcRenderer.invoke('avatarGeneration:generate', args),
  cancel: (args) => ipcRenderer.invoke('avatarGeneration:cancel', args)
} satisfies PreloadApi['avatarGeneration']
