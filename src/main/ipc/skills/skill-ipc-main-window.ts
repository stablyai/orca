import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { IpcHandleRegistrar } from '../lazy-ipc-handle-group'
import { getTrustedUIRendererWebContents } from '../ui'

let activeRegistrar: IpcHandleRegistrar = ipcMain

export function withSkillIpcRegistrar(ipc: IpcHandleRegistrar, register: () => void): void {
  const previous = activeRegistrar
  activeRegistrar = ipc
  try {
    register()
  } finally {
    activeRegistrar = previous
  }
}

export function handleMainWindowSkillIpc<Args extends unknown[], Result>(
  channel: string,
  listener: (event: IpcMainInvokeEvent, ...args: Args) => Result
): void {
  activeRegistrar.handle(channel, (event, ...args) => {
    if (getTrustedUIRendererWebContents() !== event.sender) {
      throw new Error('Unauthorized skill IPC sender')
    }
    return listener(event, ...(args as Args))
  })
}
