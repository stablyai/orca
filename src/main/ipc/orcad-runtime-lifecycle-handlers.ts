import { ipcMain } from 'electron'
import type { OrcadManagedRuntimeStatus } from '../../shared/orcad-managed-runtime'
import {
  createManagedOrcadEnvironment,
  getManagedOrcadRuntimeStatus
} from '../ssh/orcad-runtime-lifecycle'
import { registerOrcadSshProvisioningHandlers } from './orcad-ssh-provisioning-handlers'

export function registerOrcadRuntimeLifecycleHandlers(options: {
  getUserDataPath: () => string
}): void {
  registerOrcadSshProvisioningHandlers(options.getUserDataPath)
  ipcMain.handle(
    'runtimeEnvironments:deployOrcad',
    async (_event, args: { name: string; sshTargetId: string; force?: boolean }) =>
      createManagedOrcadEnvironment(options.getUserDataPath(), {
        name: requiredString(args?.name, 'Server name'),
        sshTargetId: requiredString(args?.sshTargetId, 'SSH target'),
        force: args?.force === true
      })
  )
  ipcMain.handle(
    'runtimeEnvironments:getOrcadStatus',
    (_event, args: { selector: string }): Promise<OrcadManagedRuntimeStatus> =>
      getManagedOrcadRuntimeStatus(
        options.getUserDataPath(),
        requiredString(args?.selector, 'Server')
      )
  )
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} is required.`)
  }
  return value.trim()
}
