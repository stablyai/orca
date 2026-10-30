import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../api-types'

export const linkPreviewApi = {
  get: (request) => ipcRenderer.invoke('linkPreview:get', request)
} satisfies PreloadApi['linkPreview']
