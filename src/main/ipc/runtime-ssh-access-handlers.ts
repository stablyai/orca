import { ipcMain } from 'electron'
import {
  RuntimeSshAccessLinkRequestSchema,
  RuntimeSshAccessUnlinkRequestSchema
} from '../../shared/runtime-ssh-access'
import { linkRuntimeSshAccess, unlinkRuntimeSshAccess } from '../ssh/runtime-ssh-access'
import { addFanoutListener } from '../event-listener-fanout'
import { connectRegisteredSshTarget } from '../ssh/targets/ssh-target-registry'
import { restoreManagedHostPortForwards } from './ssh/ssh-managed-port-forward-restore'
import { disconnectRegisteredSshTargetInLifecycle } from './ssh/ssh-session-teardown'

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
      const linked = await linkRuntimeSshAccess(options.getUserDataPath(), args, {
        signal: controller.signal,
        invalidateTransport: options.invalidateTransport
      })
      if (args.portsOnly) {
        // Why: no server connection brings this host up, so connect it here to carry the forwards.
        void connectRegisteredSshTarget(args.sshTargetId).catch((error: unknown) => {
          console.warn(`[ssh] Could not connect ${args.sshTargetId} for port forwards:`, error)
        })
      } else {
        // Why: the link's own connect fired before its access was saved, so it restored nothing.
        void restoreManagedHostPortForwards(args.sshTargetId, { tunnelUp: true })
      }
      return linked
    } finally {
      releaseDestroyed()
    }
  })
  ipcMain.handle('runtimeEnvironments:unlinkSshAccess', async (_event, input: unknown) => {
    const args = RuntimeSshAccessUnlinkRequestSchema.parse(input)
    return unlinkRuntimeSshAccess(options.getUserDataPath(), args, {
      invalidateTransport: options.invalidateTransport,
      endSshSession: disconnectRegisteredSshTargetInLifecycle
    })
  })
}
