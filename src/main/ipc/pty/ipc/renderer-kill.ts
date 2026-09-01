import { getPtyIpc } from '../../pty-host-bindings'
import type { Store } from '../../../persistence'
import type { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import { shutdownSinglePty } from './shutdown-single'

export type PtyKillIpcDeps = {
  store?: Store
  runtime?: OrcaRuntimeService
  getLocalPtyProviderStartupPromise: (connectionId?: string | null) => Promise<void> | undefined
  rememberSyntheticKillExit: (id: string) => void
  sendPtyExitToRenderer: (payload: { id: string; code: number; incarnationId?: string }) => void
}

/** `pty:kill` — the route the renderer takes when the user closes a terminal tab, and a separate
 *  implementation from `killPtyFromRuntimeController`. Both have to record an undelivered SSH stop,
 *  and this is the one ordinary tab close actually reaches. */
export function installPtyKillIpcHandler(deps: PtyKillIpcDeps): void {
  const ipcMain = getPtyIpc()
  const {
    store,
    runtime,
    getLocalPtyProviderStartupPromise,
    rememberSyntheticKillExit,
    sendPtyExitToRenderer
  } = deps

  ipcMain.handle('pty:kill', async (_event, args: { id: string; keepHistory?: boolean }) => {
    if (typeof args?.id !== 'string' || !args.id || args.id.startsWith('remote:')) {
      // Why: runtime terminal handles belong to terminal.close; unowned PTY routing could target the local provider.
      throw new Error('Invalid PTY provider id')
    }
    await shutdownSinglePty(
      { id: args.id, keepHistory: args.keepHistory },
      {
        store,
        runtime,
        getLocalPtyProviderStartupPromise,
        rememberSyntheticKillExit,
        sendPtyExitToRenderer
      }
    )
  })
}
