import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../api-types'

export const bitbucketServerApi = {
  connect: (args) => ipcRenderer.invoke('bitbucketServer:connect', args),
  disconnect: () => ipcRenderer.invoke('bitbucketServer:disconnect'),
  status: () => ipcRenderer.invoke('bitbucketServer:status')
} satisfies PreloadApi['bitbucketServer']
