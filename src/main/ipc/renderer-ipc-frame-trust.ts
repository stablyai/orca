import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron'

export type RendererIpcEvent = Pick<IpcMainEvent | IpcMainInvokeEvent, 'sender' | 'senderFrame'>

export function isCurrentRendererMainFrame(event: RendererIpcEvent): boolean {
  return event.senderFrame !== null && event.senderFrame === event.sender.mainFrame
}
