import type {
  NewerDaemonHeldScreen,
  NewerDaemonReopenResult
} from '../../../../shared/newer-daemon-hold'
import {
  readNewerDaemonHeldScreen,
  reopenNewerDaemonTerminals
} from '../../../daemon/daemon-newer-protocol-hold'
import { getPtyIpc } from '../../pty-host-bindings'

export function installPtyNewerDaemonHoldIpcHandlers(): void {
  const ipcMain = getPtyIpc()
  ipcMain.handle(
    'pty:readNewerDaemonHeldScreen',
    (_event, args: { sessionId: string }): Promise<NewerDaemonHeldScreen | null> =>
      typeof args?.sessionId === 'string'
        ? readNewerDaemonHeldScreen(args.sessionId)
        : Promise.resolve(null)
  )
  ipcMain.handle('pty:reopenNewerDaemonTerminals', (): Promise<NewerDaemonReopenResult> =>
    reopenNewerDaemonTerminals()
  )
}
