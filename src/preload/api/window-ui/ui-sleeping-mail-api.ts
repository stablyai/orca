import { ipcRenderer } from 'electron'
import type { SleepingAgentWakeRequest } from '../../../shared/workspace/lifecycle/workspace-sleep'
import type { SleepingMailChange } from '../../../shared/workspace/lifecycle/sleeping-mail-change'

export type SleepingMailUiApi = {
  onSleepingMailChanged: (callback: (change: SleepingMailChange) => void) => () => void
  replySleepingAgentWake: (reply: { requestId: string; woke: boolean }) => void
  notifySleepingMailAvailability: (paneKey?: string) => void
  /** Asks for the whole held set, after this window (re)subscribed and may have missed changes. */
  requestSleepingMailSnapshot: () => void
  onResumeSleepingAgents: (callback: (data: SleepingAgentWakeRequest) => void) => () => void
}

export const sleepingMailUiApi = {
  onSleepingMailChanged: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, change: SleepingMailChange) =>
      callback(change)
    ipcRenderer.on('ui:sleepingMailChanged', listener)
    return () => ipcRenderer.removeListener('ui:sleepingMailChanged', listener)
  },
  replySleepingAgentWake: (reply) => ipcRenderer.send('ui:resumeSleepingAgentsReply', reply),
  notifySleepingMailAvailability: (paneKey) =>
    ipcRenderer.send('ui:sleepingMailAvailability', paneKey),
  requestSleepingMailSnapshot: () => ipcRenderer.send('ui:sleepingMailSnapshot'),
  onResumeSleepingAgents: (callback: (data: SleepingAgentWakeRequest) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: SleepingAgentWakeRequest) =>
      callback(data)
    ipcRenderer.on('ui:resumeSleepingAgents', listener)
    return () => ipcRenderer.removeListener('ui:resumeSleepingAgents', listener)
  }
} satisfies SleepingMailUiApi
