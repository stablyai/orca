import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../api-types'

export const avatarGenerationApi = {
  capability: (options) => ipcRenderer.invoke('avatarGeneration:capability', options),
  generate: (args) => ipcRenderer.invoke('avatarGeneration:generate', args),
  cancel: (args) => ipcRenderer.invoke('avatarGeneration:cancel', args)
} satisfies PreloadApi['avatarGeneration']
