import { accountRestartErrorReceipt } from '../pane/account-restart-owner'
import {
  formatAccountRestartFailure,
  readAccountRestartCondition
} from '../../../../shared/terminal/pty/lifecycle/account-restart-contract'
import { formatTerminalStartFailure } from '../../../../shared/terminal/pty/lifecycle/terminal-start-failure'
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
      const condition = readAccountRestartCondition(args.accountRestart)
      const receipt =
        accountRestartErrorReceipt(error) ??
        (condition
          ? {
              v: 1 as const,
              requestId: condition.requestId,
              attemptId: condition.attemptId,
              stop: 'unknown' as const
            }
          : undefined)
      const detail =
        formatTerminalStartFailure(error) ??
        (error instanceof Error ? error.message : String(error))
      if (receipt) {
        throw new Error(formatAccountRestartFailure(detail, receipt))
      }
      const message = formatTerminalStartFailure(error)
      if (message) {
        throw new Error(message)
      }
      throw error
    }
  })
}
