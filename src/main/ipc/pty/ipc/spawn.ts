import { getPtyIpc } from '../../pty-host-bindings'
import { runPtyIpcSpawn } from './spawn-run'
import type { PtySpawnIpcArgs, PtySpawnIpcDeps } from './spawn-types'
import { getConnectionExecutionHostId } from '../../../../shared/execution-host'
import { installWindowPtySpawn } from './window-pty-spawn'

export function installPtySpawnIpcHandler(deps: PtySpawnIpcDeps): void {
  const ipcMain = getPtyIpc()
  const { getLocalPtyStartupPromise, getSettings } = deps

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
  installWindowPtySpawn(getSettings ? { spawn, getSettings } : null)
}
