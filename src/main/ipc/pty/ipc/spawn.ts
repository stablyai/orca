import { formatTerminalStartFailure } from '../../../../shared/terminal-start-failure'
import { getPtyIpc } from '../pty-host-bindings'
import { runPtyIpcSpawn } from './spawn-run'
import type { PtySpawnIpcArgs, PtySpawnIpcDeps } from './spawn-types'
import { getConnectionExecutionHostId } from '../../../../shared/execution-host'
import { attachOnlyViewOf, attachViewAfterHiddenStart } from '../pane/attach-only-view'

export function installPtySpawnIpcHandler(deps: PtySpawnIpcDeps): void {
  const ipcMain = getPtyIpc()
  const { getLocalPtyStartupPromise } = deps

  ipcMain.handle('pty:spawn', async (_event, args: PtySpawnIpcArgs) => {
    try {
      const startupPromise = getLocalPtyStartupPromise(
        getConnectionExecutionHostId(args.connectionId)
      )
      if (startupPromise) {
        await startupPromise
      }
      if (attachOnlyViewOf(args) && args.sessionId && args.initiallyHidden !== true) {
        return await attachViewAfterHiddenStart(
          args.sessionId,
          deps.transitionSpawnHiddenRendererPtyDeliveryState,
          () => runPtyIpcSpawn(deps, args)
        )
      }
      return await runPtyIpcSpawn(deps, args)
    } catch (error) {
      const message = formatTerminalStartFailure(error)
      if (message) {
        throw new Error(message)
      }
      throw error
    }
  })
}
