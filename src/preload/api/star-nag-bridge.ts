import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../api-types'

export const starNagApi = {
  onShow: (
    callback: (payload?: { mode?: 'gh' | 'web'; surface?: 'card' | 'toast' }) => void
  ): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      payload?: { mode?: 'gh' | 'web'; surface?: 'card' | 'toast' }
    ): void => callback(payload)
    ipcRenderer.on('star-nag:show', listener)
    return () => ipcRenderer.removeListener('star-nag:show', listener)
  },
  onHide: (callback: () => void): (() => void) => {
    const listener = (): void => callback()
    ipcRenderer.on('star-nag:hide', listener)
    return () => ipcRenderer.removeListener('star-nag:hide', listener)
  },
  dismiss: (): Promise<void> => ipcRenderer.invoke('star-nag:dismiss'),
  later: (): Promise<void> => ipcRenderer.invoke('star-nag:later'),
  complete: (): Promise<void> => ipcRenderer.invoke('star-nag:complete'),
  disable: (): Promise<void> => ipcRenderer.invoke('star-nag:disable'),
  openWeb: (): Promise<void> => ipcRenderer.invoke('star-nag:openWeb'),
  starOrca: (): Promise<boolean> => ipcRenderer.invoke('star-nag:starOrca'),
  forceShow: (): Promise<void> => ipcRenderer.invoke('star-nag:forceShow'),
  agentValueMoment: (): Promise<{ status: 'ready'; mode: 'gh' | 'web' } | { status: 'skipped' }> =>
    ipcRenderer.invoke('star-nag:agentValueMoment'),
  showAgentValueMoment: (): Promise<void> => ipcRenderer.invoke('star-nag:showAgentValueMoment'),
  onboardingCompleted: (): Promise<void> => ipcRenderer.invoke('star-nag:onboardingCompleted')
} satisfies PreloadApi['starNag']
