import { getPtyIpc } from '../../pty-host-bindings'
import { recordProviderResourceDiagnosticOutcome } from '../../../diagnostics/provider-resource-diagnostic-routing'
import { runPtyIpcSpawn } from './spawn-run'
import type { PtySpawnIpcArgs, PtySpawnIpcDeps } from './spawn-types'

export function installPtySpawnIpcHandler(deps: PtySpawnIpcDeps): void {
  const ipcMain = getPtyIpc()
  const { getLocalPtyStartupPromise } = deps

  ipcMain.handle('pty:spawn', async (_event, args: PtySpawnIpcArgs) => {
    const startupPromise = getLocalPtyStartupPromise(args.connectionId)
    if (startupPromise) {
      await startupPromise
    }
    try {
      const result = await runPtyIpcSpawn(deps, args)
      recordProviderResourceDiagnosticOutcome(
        args.env?.ORCA_PROVIDER_RESOURCE_DIAGNOSTIC_REQUEST_ID,
        result.isReattach === true ? 'attached' : 'spawned'
      )
      return result
    } catch (error) {
      recordProviderResourceDiagnosticOutcome(
        args.env?.ORCA_PROVIDER_RESOURCE_DIAGNOSTIC_REQUEST_ID,
        'failed'
      )
      throw error
    }
  })
}
