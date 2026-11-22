import { accountRestartErrorReceipt } from '../pane/account-restart-owner'
import {
  formatAccountRestartFailure,
  readAccountRestartCondition,
  type AccountRestartReceipt
} from '../../../../shared/terminal/pty/lifecycle/account-restart-contract'
import { formatTerminalStartFailure } from '../../../../shared/terminal/pty/lifecycle/terminal-start-failure'
import { getPtyIpc } from '../pty-host-bindings'
import { runPtyIpcSpawn } from './spawn-run'
import type { PtySpawnIpcArgs, PtySpawnIpcDeps } from './spawn-types'
import { getConnectionExecutionHostId } from '../../../../shared/execution-host/execution-host'
import { attachOnlyViewOf, attachViewAfterHiddenStart } from '../pane/attach-only-view'
import { DesktopRuntimeSenderLifecycle } from '../../runtime-client/desktop-runtime-sender-lifecycle'

export function installPtySpawnIpcHandler(deps: PtySpawnIpcDeps): void {
  const ipcMain = getPtyIpc()
  const { getLocalPtyStartupPromise } = deps
  const desktopSenders = new DesktopRuntimeSenderLifecycle()

  ipcMain.handle('pty:spawn', async (event, args: PtySpawnIpcArgs) => {
    const condition = readAccountRestartCondition(args.accountRestart)
    let started = false
    try {
      if (condition && (!event.senderFrame || event.senderFrame !== event.sender.mainFrame)) {
        throw new Error('client_disconnected')
      }
      const signal = condition ? desktopSenders.unaryContextFor(event.sender).signal : undefined
      const startupPromise = getLocalPtyStartupPromise(
        getConnectionExecutionHostId(args.connectionId)
      )
      if (startupPromise) {
        await startupPromise
      }
      if (signal?.aborted) {
        throw new Error('client_disconnected')
      }
      const spawn = () => {
        started = true
        return runPtyIpcSpawn(deps, { ...args, signal })
      }
      if (attachOnlyViewOf(args) && args.sessionId && args.initiallyHidden !== true) {
        return await attachViewAfterHiddenStart(
          args.sessionId,
          deps.transitionSpawnHiddenRendererPtyDeliveryState,
          spawn
        )
      }
      return await spawn()
    } catch (error) {
      const receipt: AccountRestartReceipt | undefined =
        accountRestartErrorReceipt(error) ??
        (condition
          ? {
              v: 1,
              requestId: condition.requestId,
              attemptId: condition.attemptId,
              stop: started ? 'unknown' : 'not-started',
              outcome: started ? 'unknown' : 'terminal'
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
