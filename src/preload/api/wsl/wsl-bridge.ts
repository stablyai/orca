import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../../api-types'

export const wslApi = {
  isAvailable: (): Promise<boolean> => ipcRenderer.invoke('wsl:isAvailable'),
  listDistros: (): Promise<string[]> => ipcRenderer.invoke('wsl:listDistros'),
  resolveMappedDrivePath: (path: string): Promise<string | null> =>
    ipcRenderer.invoke('wsl:resolveMappedDrivePath', path)
} satisfies PreloadApi['wsl']
