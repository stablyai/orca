import { ipcMain } from 'electron'
import {
  RuntimeSshAccessLinkRequestSchema,
  RuntimeSshAccessUnlinkRequestSchema
} from '../../shared/runtime-ssh-access'
import { linkRuntimeSshAccess, unlinkRuntimeSshAccess } from '../ssh/runtime-ssh-access'
import { addFanoutListener } from '../event-listener-fanout'

export function registerRuntimeSshAccessHandlers(options: {
  getUserDataPath: () => string
  invalidateTransport: (environmentId: string) => void | Promise<void>
}): void {
  ipcMain.handle('runtimeEnvironments:linkSshAccess', async (event, input: unknown) => {
    const args = RuntimeSshAccessLinkRequestSchema.parse(input)
    // Unreachable links hold two lifecycle queues; cancel when their window closes.
    const controller = new AbortController()
    const cancel = (): void => controller.abort()
    const releaseDestroyed = addFanoutListener(event.sender, 'destroyed', cancel)
    try {
      return await linkRuntimeSshAccess(options.getUserDataPath(), args, {
        signal: controller.signal,
        invalidateTransport: options.invalidateTransport
      })
    } finally {
      releaseDestroyed()
    }
  })
  ipcMain.handle('runtimeEnvironments:unlinkSshAccess', async (_event, input: unknown) => {
    const args = RuntimeSshAccessUnlinkRequestSchema.parse(input)
    return unlinkRuntimeSshAccess(options.getUserDataPath(), args, {
      invalidateTransport: options.invalidateTransport
    })
  })
}
