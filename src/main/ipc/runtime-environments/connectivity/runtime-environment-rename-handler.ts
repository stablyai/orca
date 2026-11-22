import { ipcMain } from 'electron'
import {
  renameEnvironment,
  resolveEnvironment
} from '../../../../shared/remote-runtime/host-store/runtime-environment-store'
import {
  redactRuntimeEnvironment,
  type PublicKnownRuntimeEnvironment
} from '../../../../shared/remote-runtime/host-catalog/runtime-environments'

export function registerRuntimeEnvironmentRenameHandler(getUserDataPath: () => string): void {
  ipcMain.handle(
    'runtimeEnvironments:rename',
    async (
      _event,
      args: { selector: string; name: string }
    ): Promise<{ environment: PublicKnownRuntimeEnvironment }> => {
      if (typeof args.name !== 'string') {
        throw new Error('Renaming a server requires a name.')
      }
      // Resolve merged first: an unreadable sidecar hides the record rather than lose its links.
      const environment = await resolveEnvironment(getUserDataPath(), args.selector)
      const renamed = await renameEnvironment(getUserDataPath(), environment.id, {
        name: args.name
      })
      return {
        environment: redactRuntimeEnvironment({
          ...environment,
          name: renamed.name,
          updatedAt: renamed.updatedAt
        })
      }
    }
  )
}
