import { ipcRenderer } from 'electron'
import type { SleepingAgentWakeRequest } from '../../shared/workspace-sleep'

export type SleepingMailUiApi = {
  onSleepingMailChanged: (
    callback: (worktreeIds: string[], settledMailWakeIds?: string[]) => void
  ) => () => void
  replySleepingAgentWake: (reply: { requestId: string; woke: boolean }) => void
  notifySleepingMailAvailability: () => void
  onResumeSleepingAgents: (callback: (data: SleepingAgentWakeRequest) => void) => () => void
}

export const sleepingMailUiApi = {
  onSleepingMailChanged: (callback) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      notice: { worktreeIds: string[]; settledMailWakeIds?: string[] }
    ) => callback(notice.worktreeIds, notice.settledMailWakeIds)
    ipcRenderer.on('ui:sleepingMailChanged', listener)
    return () => ipcRenderer.removeListener('ui:sleepingMailChanged', listener)
  },
  replySleepingAgentWake: (reply) => ipcRenderer.send('ui:resumeSleepingAgentsReply', reply),
  notifySleepingMailAvailability: () => ipcRenderer.send('ui:sleepingMailAvailability'),
  onResumeSleepingAgents: (callback: (data: SleepingAgentWakeRequest) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: SleepingAgentWakeRequest) =>
      callback(data)
    ipcRenderer.on('ui:resumeSleepingAgents', listener)
    return () => ipcRenderer.removeListener('ui:resumeSleepingAgents', listener)
  }
} satisfies SleepingMailUiApi
