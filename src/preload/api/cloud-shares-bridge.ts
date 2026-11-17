import { ipcRenderer } from 'electron'
import { CLOUD_SHARE_CHANNELS } from '../../shared/hosted-sandbox/hosted-sandbox-share-wire'
import type { PreloadApi } from '../api-types'

export const cloudSharesApi = {
  list: (args) => ipcRenderer.invoke(CLOUD_SHARE_CHANNELS.list, args),
  create: (args) => ipcRenderer.invoke(CLOUD_SHARE_CHANNELS.create, args),
  revoke: (args) => ipcRenderer.invoke(CLOUD_SHARE_CHANNELS.revoke, args),
  open: (args) => ipcRenderer.invoke(CLOUD_SHARE_CHANNELS.open, args)
} satisfies PreloadApi['cloudShares']
