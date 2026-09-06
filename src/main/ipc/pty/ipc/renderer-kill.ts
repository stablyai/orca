import { getPtyIpc } from '../../pty-host-bindings'
import type { Store } from '../../../persistence'
import type { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import type { IPtyProvider } from '../../../providers/types'
import { parseAppSshPtyId } from '../../../providers/ssh-pty-id'
import { SSH_PROVIDER_UNREGISTERED_REASON } from '../../../../shared/pty-liveness-verdict'
import { ptyOwnership } from '../provider/ownership-state'
import { getProviderForPty, sshProviders, tryGetProviderForPty } from '../provider/registry'
import { finishPtyShutdown, isPtyAlreadyGoneError } from '../provider/liveness'
import { recordUndeliveredSshPtyKill } from '../runtime/undelivered-ssh-kill'

export type PtyKillIpcDeps = {
  store?: Store
  runtime?: OrcaRuntimeService
  getLocalPtyProviderStartupPromise: (connectionId?: string | null) => Promise<void> | undefined
  shutdownProviderAndDetectExit: (
    provider: IPtyProvider,
    id: string,
    opts: { immediate?: boolean; keepHistory?: boolean; deadlineMs?: number }
  ) => Promise<boolean>
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
    shutdownProviderAndDetectExit,
    rememberSyntheticKillExit,
    sendPtyExitToRenderer
  } = deps

  ipcMain.handle('pty:kill', async (_event, args: { id: string; keepHistory?: boolean }) => {
    if (typeof args?.id !== 'string' || !args.id || args.id.startsWith('remote:')) {
      // Why: runtime terminal handles belong to terminal.close; unowned PTY routing could target the local provider.
      throw new Error('Invalid PTY provider id')
    }
    runtime?.markPtyStopRequested?.(args.id)
    const ownedConnectionId = ptyOwnership.get(args.id)
    const parsedSshId = ownedConnectionId === undefined ? parseAppSshPtyId(args.id) : null
    const connectionId = ownedConnectionId ?? parsedSshId?.connectionId
    // Why: wait for daemon startup before selecting the local provider, else a fallback shutdown falsely succeeds and orphans a restored daemon PTY (#7742).
    const startupPromise = getLocalPtyProviderStartupPromise(connectionId)
    if (startupPromise) {
      await startupPromise
    }
    // Why stated rather than inferred: this IPC serves both the ordinary tab close and pane
    // hibernation, and only hibernation passes keepHistory. Recording a replayable kill for a
    // hibernating pane would destroy it on the next handshake.
    const reversible = args.keepHistory === true
    const provider = connectionId ? sshProviders.get(connectionId) : tryGetProviderForPty(args.id)
    if (!provider && connectionId) {
      // Why: detached SSH PTYs intentionally keep ownership after their
      // provider is unregistered; hydrated app-scoped ids can also arrive
      // before ownership is rebuilt. Tombstone instead of falling back local.
      const incarnationId = finishPtyShutdown(args.id, connectionId, store)
      // The relay was never asked, so the remote shell is still running. Keep the order.
      recordUndeliveredSshPtyKill({
        store,
        ptyId: args.id,
        connectionId,
        reversible,
        incarnationId
      })
      runtime?.markPtyLivenessUnverifiable?.(args.id, SSH_PROVIDER_UNREGISTERED_REASON)
      runtime?.onPtyExit(args.id, -1, incarnationId)
      rememberSyntheticKillExit(args.id)
      sendPtyExitToRenderer({
        id: args.id,
        code: -1,
        ...(incarnationId ? { incarnationId } : {})
      })
      return
    }
    const shutdownProvider = provider ?? getProviderForPty(args.id)
    let providerExitObserved = false
    try {
      providerExitObserved = await shutdownProviderAndDetectExit(shutdownProvider, args.id, {
        immediate: true,
        keepHistory: args.keepHistory ?? false
      })
    } catch (err) {
      if (!isPtyAlreadyGoneError(err)) {
        // Why: a failed shutdown can leave the process alive (SSH relay grace window / local daemon); keep ownership/lease state so the user can retry.
        // The renderer has already discarded the tab, so nothing here retries — the durable order
        // is what lets the next handshake to this host finish the close.
        recordUndeliveredSshPtyKill({ store, ptyId: args.id, connectionId, reversible })
        throw err
      }
      /* session already dead — cleanup below handles the rest */
    }
    // Why: some shutdown paths do not emit onExit through the provider listener.
    // Explicit cleanup is idempotent and covers already-dead PTYs.
    const incarnationId = finishPtyShutdown(args.id, connectionId, store)
    if (!providerExitObserved) {
      runtime?.onPtyExit(args.id, -1, incarnationId)
      rememberSyntheticKillExit(args.id)
      sendPtyExitToRenderer({
        id: args.id,
        code: -1,
        ...(incarnationId ? { incarnationId } : {})
      })
    }
  })
}
