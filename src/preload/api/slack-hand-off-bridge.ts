import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../api-types'

export const slackHandOffApi = {
  redeem: (args) => ipcRenderer.invoke('slackHandOff:redeem', args)
} satisfies PreloadApi['slackHandOff']
