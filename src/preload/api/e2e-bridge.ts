import { preloadE2EConfig } from '../e2e-config'
import type { PreloadApi } from '../api-types'
import { ipcRenderer } from 'electron'

export const e2eApi = {
  getConfig: () => preloadE2EConfig,
  menuBar: (command: { operation: 'inspect' | 'invoke' | 'tracking'; action?: string }) =>
    ipcRenderer.invoke('e2e:menuBar', command)
} satisfies PreloadApi['e2e']
