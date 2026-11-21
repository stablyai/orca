import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../../api-types'

export const browserGuestDiscardApi = {
  reportGuestVisibility: (report) => ipcRenderer.send('browser:reportGuestVisibility', report),
  refuseGuestIdleDiscard: (request) => ipcRenderer.send('browser:refuseGuestIdleDiscard', request),
  onGuestIdleDiscardDue: (callback): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      request: Parameters<typeof callback>[0]
    ): void => callback(request)
    ipcRenderer.on('browser:guest-idle-discard-due', listener)
    return () => ipcRenderer.removeListener('browser:guest-idle-discard-due', listener)
  },
  preparePageAttach: (args) => ipcRenderer.invoke('browser:preparePageAttach', args),
  reserveGuestDiscard: (args) => ipcRenderer.sendSync('browser:reserveGuestDiscard', args) === true,
  acknowledgeGuestRemoval: (args) => ipcRenderer.invoke('browser:acknowledgeGuestRemoval', args),
  getGuestDiscardProtection: (args) =>
    ipcRenderer.invoke('browser:getGuestDiscardProtection', args),
  onGuestDiscardProtectionChanged: (callback): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: Parameters<typeof callback>[0]
    ): void => callback(data)
    ipcRenderer.on('browser:guest-discard-protection-changed', listener)
    return () => ipcRenderer.removeListener('browser:guest-discard-protection-changed', listener)
  },
  onLoadStall: (callback): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      data: Parameters<typeof callback>[0]
    ): void => callback(data)
    ipcRenderer.on('browser:load-stall', listener)
    return () => ipcRenderer.removeListener('browser:load-stall', listener)
  }
} satisfies Partial<PreloadApi['browser']>
