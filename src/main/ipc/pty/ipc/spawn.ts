import { getPtyIpc } from '../../pty-host-bindings'
import { runPtyIpcSpawn } from './spawn-run'
import type { PtySpawnIpcArgs, PtySpawnIpcDeps } from './spawn-types'
import { isLaunchFileUnavailableMessage } from '../../../../shared/launch-prompt-file'
import {
  noteTerminalPaneSpawn,
  recordTerminalLaunchRefusal
} from '../../../runtime/terminal-launch-refusals'

export function installPtySpawnIpcHandler(deps: PtySpawnIpcDeps): void {
  const ipcMain = getPtyIpc()
  const { getLocalPtyStartupPromise } = deps

  ipcMain.handle('pty:spawn', async (_event, args: PtySpawnIpcArgs) => {
    const startupPromise = getLocalPtyStartupPromise(args.connectionId)
    if (startupPromise) {
      await startupPromise
    }
    // Why: a create waiting on this tab's handle keeps waiting while the spawn still runs.
    const settleSpawn = args.tabId ? noteTerminalPaneSpawn(args.tabId) : () => {}
    try {
      return await runPtyIpcSpawn(deps, args)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // Why: a runtime create waits on this tab's handle; the refusal is the answer it waits for.
      if (args.tabId && isLaunchFileUnavailableMessage(message)) {
        recordTerminalLaunchRefusal(args.tabId, message)
      }
      throw error
    } finally {
      settleSpawn()
    }
  })
}
