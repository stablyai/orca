import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../api-types'

export const wslApi = {
  isAvailable: (): Promise<boolean> => ipcRenderer.invoke('wsl:isAvailable'),
  listDistros: (): Promise<string[]> => ipcRenderer.invoke('wsl:listDistros'),
  listRunningDistros: (): Promise<string[]> => ipcRenderer.invoke('wsl:listRunningDistros'),
  getDistroHome: (distro: string): Promise<string | null> =>
    ipcRenderer.invoke('wsl:getDistroHome', distro)
} satisfies PreloadApi['wsl']
