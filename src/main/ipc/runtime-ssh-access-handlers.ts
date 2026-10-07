import { ipcMain } from 'electron'
import {
  RuntimeSshAccessLinkRequestSchema,
  RuntimeSshAccessUnlinkRequestSchema
} from '../../shared/runtime-ssh-access'
import { linkRuntimeSshAccess, unlinkRuntimeSshAccess } from '../ssh/runtime-ssh-access'

export function registerRuntimeSshAccessHandlers(options: {
  getUserDataPath: () => string
  invalidateTransport: (environmentId: string) => void | Promise<void>
}): void {
  ipcMain.handle('runtimeEnvironments:linkSshAccess', async (event, input: unknown) => {
    const args = RuntimeSshAccessLinkRequestSchema.parse(input)
    // Why: a link to an unreachable host holds two lifecycle queues; a closed window cancels it.
    const controller = new AbortController()
    const cancel = (): void => controller.abort()
    event.sender.once('destroyed', cancel)
    try {
      return await linkRuntimeSshAccess(options.getUserDataPath(), args, {
        signal: controller.signal,
        invalidateTransport: options.invalidateTransport
      })
    } finally {
      event.sender.removeListener('destroyed', cancel)
    }
  })
  ipcMain.handle('runtimeEnvironments:unlinkSshAccess', async (_event, input: unknown) => {
    const args = RuntimeSshAccessUnlinkRequestSchema.parse(input)
    return unlinkRuntimeSshAccess(options.getUserDataPath(), args, {
      invalidateTransport: options.invalidateTransport
    })
  })
}
