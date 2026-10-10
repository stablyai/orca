import { getPtyIpc } from '../../pty-host-bindings'
import { runPtyIpcSpawn } from './spawn-run'
import type { PtySpawnIpcArgs, PtySpawnIpcDeps } from './spawn-types'
import { getConnectionExecutionHostId } from '../../../../shared/execution-host'

export function installPtySpawnIpcHandler(deps: PtySpawnIpcDeps): void {
  const ipcMain = getPtyIpc()
  const { getLocalPtyStartupPromise } = deps

  ipcMain.handle('pty:spawn', async (_event, args: PtySpawnIpcArgs) => {
    const startupPromise = getLocalPtyStartupPromise(
      getConnectionExecutionHostId(args.connectionId)
    )
    if (startupPromise) {
      await startupPromise
    }
    return runPtyIpcSpawn(deps, args)
  })
}
