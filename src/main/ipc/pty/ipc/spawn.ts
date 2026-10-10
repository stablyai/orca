import { getPtyIpc } from '../../pty-host-bindings'
import { runPtyIpcSpawn } from './spawn-run'
import type { PtySpawnIpcArgs, PtySpawnIpcDeps } from './spawn-types'
import { getConnectionExecutionHostId } from '../../../../shared/execution-host'
import type { WindowPtySpawn } from './window-pty-spawn'

/** Answers the spawn the handler runs, for a host launch that must spawn as the window does. */
export function installPtySpawnIpcHandler(deps: PtySpawnIpcDeps): WindowPtySpawn['spawn'] {
  const ipcMain = getPtyIpc()
  const { getLocalPtyStartupPromise } = deps

  const spawn = async (args: PtySpawnIpcArgs) => {
    const startupPromise = getLocalPtyStartupPromise(
      getConnectionExecutionHostId(args.connectionId)
    )
    if (startupPromise) {
      await startupPromise
    }
    return runPtyIpcSpawn(deps, args)
  }
  ipcMain.handle('pty:spawn', async (_event, args: PtySpawnIpcArgs) => spawn(args))
  return spawn
}
