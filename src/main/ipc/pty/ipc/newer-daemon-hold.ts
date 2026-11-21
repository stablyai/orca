import type {
  NewerDaemonHeldScreen,
  NewerDaemonReopenResult
} from '../../../../shared/terminal/daemon/newer-daemon-hold'
import {
  readNewerDaemonHeldScreen,
  reopenNewerDaemonTerminals
} from '../../../daemon/providers/routing/daemon-newer-protocol-hold'
import { getPtyIpc } from '../pty-host-bindings'

// One saved-screen read at a time: a restore burst can hold many panes, and each read parses a checkpoint on main.
let heldScreenReads: Promise<unknown> = Promise.resolve()

function readHeldScreenInTurn(sessionId: string): Promise<NewerDaemonHeldScreen | null> {
  const read = heldScreenReads.then(() => readNewerDaemonHeldScreen(sessionId))
  heldScreenReads = read.catch(() => null)
  return read
}

export function installPtyNewerDaemonHoldIpcHandlers(): void {
  const ipcMain = getPtyIpc()
  ipcMain.handle(
    'pty:readNewerDaemonHeldScreen',
    (_event, args: { sessionId: string }): Promise<NewerDaemonHeldScreen | null> =>
      typeof args?.sessionId === 'string'
        ? readHeldScreenInTurn(args.sessionId)
        : Promise.resolve(null)
  )
  ipcMain.handle('pty:reopenNewerDaemonTerminals', (): Promise<NewerDaemonReopenResult> =>
    reopenNewerDaemonTerminals()
  )
}
