import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../api-types'

export const editorApi = {
  formatOnSave: (args) => ipcRenderer.invoke('editor:formatOnSave', args)
} satisfies PreloadApi['editor']
