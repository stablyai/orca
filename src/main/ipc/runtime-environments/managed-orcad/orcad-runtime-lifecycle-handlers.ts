import { ipcMain } from 'electron'
import type { IpcHandleRegistrar } from '../../lazy-ipc-handle-group'
import type { OrcadManagedRuntimeStatus } from '../../../../shared/remote-runtime/orcad-lifecycle/orcad-managed-runtime'
import { createManagedOrcadEnvironment } from '../../../managed-server/lifecycle/orcad-runtime-deployment'
import { getManagedOrcadRuntimeStatus } from '../../../managed-server/lifecycle/orcad-runtime-status'

export function registerOrcadRuntimeLifecycleHandlers(
  options: {
    getUserDataPath: () => string
  },
  ipc: IpcHandleRegistrar = ipcMain
): void {
  ipc.handle(
    'runtimeEnvironments:deployOrcad',
    async (_event, args: { name: string; sshTargetId: string; force?: boolean }) =>
      createManagedOrcadEnvironment(options.getUserDataPath(), {
        name: requiredString(args?.name, 'Server name'),
        sshTargetId: requiredString(args?.sshTargetId, 'SSH target'),
        force: args?.force === true
      })
  )
  ipc.handle(
    'runtimeEnvironments:getOrcadStatus',
    (_event, args: { selector: string }): Promise<OrcadManagedRuntimeStatus> =>
      getManagedOrcadRuntimeStatus(
        options.getUserDataPath(),
        requiredString(args?.selector, 'Server')
      )
  )
}

export function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} is required.`)
  }
  return value.trim()
}
