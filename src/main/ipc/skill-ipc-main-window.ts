import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { isTrustedUIRenderer } from './ui'

export function handleMainWindowSkillIpc<Args extends unknown[], Result>(
  channel: string,
  listener: (event: IpcMainInvokeEvent, ...args: Args) => Result
): void {
  ipcMain.handle(channel, (event, ...args) => {
    if (!isTrustedUIRenderer(event.sender)) {
      throw new Error('Unauthorized skill IPC sender')
    }
    return listener(event, ...(args as Args))
  })
}
