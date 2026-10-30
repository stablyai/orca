import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../api-types'

export const d2Api = {
  render: (args) => ipcRenderer.invoke('d2:render', args)
} satisfies PreloadApi['d2']
