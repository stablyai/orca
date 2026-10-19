import { ipcRenderer } from 'electron'
import {
  SCHEDULED_MESSAGES_UPDATE_CHANNEL,
  type ScheduledMessage,
  type ScheduledMessageChanges,
  type ScheduledMessageDraft,
  type ScheduledMessagesSnapshot
} from '../../shared/scheduled-message-types'
import type { PreloadApi } from '../api-types'

export const scheduledMessagesApi = {
  get: (): Promise<ScheduledMessagesSnapshot> => ipcRenderer.invoke('scheduledMessages:get'),
  add: (draft: ScheduledMessageDraft): Promise<ScheduledMessage | null> =>
    ipcRenderer.invoke('scheduledMessages:add', draft),
  update: (messageId: string, changes: ScheduledMessageChanges): Promise<void> =>
    ipcRenderer.invoke('scheduledMessages:update', messageId, changes),
  delete: (messageId: string): Promise<void> =>
    ipcRenderer.invoke('scheduledMessages:delete', messageId),
  sendNow: (messageId: string): Promise<void> =>
    ipcRenderer.invoke('scheduledMessages:sendNow', messageId),
  onUpdate: (callback: (snapshot: ScheduledMessagesSnapshot) => void): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      snapshot: ScheduledMessagesSnapshot
    ): void => callback(snapshot)
    ipcRenderer.on(SCHEDULED_MESSAGES_UPDATE_CHANNEL, listener)
    return () => ipcRenderer.removeListener(SCHEDULED_MESSAGES_UPDATE_CHANNEL, listener)
  }
} satisfies PreloadApi['scheduledMessages']
