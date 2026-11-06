import type { RuntimeTerminalAttention } from '../../../../shared/runtime-terminal-contracts'
import type { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import { getPtyIpc } from '../pty-host-bindings'
import type { PtyRendererDelivery } from '../session'
import { isMainWindowPtyIpcEvent } from './write-input'

const MAX_ATTENTION_PTY_IDS = 10_000

/** Agent sleep in this window must see what paired clients and phones are doing with its PTYs. */
export function installPtyTerminalAttentionIpcHandler(deps: {
  mainWindow?: PtyRendererDelivery
  runtime?: OrcaRuntimeService
}): void {
  const ipcMain = getPtyIpc()
  ipcMain.removeHandler('pty:getTerminalAttention')
  ipcMain.handle(
    'pty:getTerminalAttention',
    (event, ids: unknown): Record<string, RuntimeTerminalAttention> => {
      const { runtime } = deps
      if (
        !runtime ||
        !isMainWindowPtyIpcEvent(event, deps.mainWindow) ||
        !Array.isArray(ids) ||
        ids.length > MAX_ATTENTION_PTY_IDS
      ) {
        return {}
      }
      const attention: Record<string, RuntimeTerminalAttention> = {}
      for (const id of ids) {
        if (typeof id === 'string' && id.length > 0) {
          attention[id] = runtime.getTerminalAttention(id)
        }
      }
      return attention
    }
  )
}
