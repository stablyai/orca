import type { IPtyProvider } from '../../../providers/types'
import { SSH_PROVIDER_UNREGISTERED_REASON } from '../../../../shared/pty-liveness-verdict'
import { parseAppSshPtyId } from '../../../providers/ssh-pty-id'
import { ptyOwnership, ptyIncarnationById } from '../provider/ownership-state'
import { getProvider, getProviderForPty } from '../provider/registry'
import { isPtyAlreadyGoneError } from '../provider/liveness'
import { recordUndeliveredSshPtyKill } from './undelivered-ssh-kill'
import type { PtyRuntimeControllerDeps } from './controller-deps'
import { finishPtyShutdownAfterExit } from './pty-shutdown-reconciliation'

export { stopAndWaitPtyFromRuntimeController } from './pty-stop-and-wait'

export function killPtyFromRuntimeController(
  deps: PtyRuntimeControllerDeps,
  ptyId: string
): boolean {
  const {
    runtime,
    store,
    getLocalPtyProviderStartupPromise,
    shutdownProviderAndDetectExit,
    rememberSyntheticKillExit,
    sendPtyExitToRenderer,
    finishPtyShutdown,
    retiredRejectedPtyIds,
    reversibleStopOwnersByPtyId
  } = deps
  runtime?.markPtyStopRequested?.(ptyId)
  let connectionId: string | null | undefined = ptyOwnership.get(ptyId)
  const parsedSshId = connectionId === undefined ? parseAppSshPtyId(ptyId) : null
  connectionId ??= parsedSshId?.connectionId
  const recordUndelivered = (incarnationId?: string): void => {
    recordUndeliveredSshPtyKill({
      store,
      ptyId,
      connectionId,
      reversible: reversibleStopOwnersByPtyId.has(ptyId),
      incarnationId
    })
  }
  const killWithCurrentProvider = (): boolean => {
    let provider: IPtyProvider
    try {
      provider = connectionId ? getProvider(connectionId) : getProviderForPty(ptyId)
    } catch {
      if (connectionId) {
        // Why: runtime/CLI close can target a detached SSH PTY after its
        // provider was unregistered. Tombstone the lease so reconnect does
        // not revive a terminal the user explicitly closed.
        const incarnationId = finishPtyShutdownAfterExit(
          runtime,
          finishPtyShutdown,
          ptyId,
          connectionId,
          store,
          -1
        )
        // The relay was never asked, so the remote shell is still running. Keep the order.
        recordUndelivered(incarnationId)
        rememberSyntheticKillExit(ptyId)
        sendPtyExitToRenderer({
          id: ptyId,
          code: -1,
          ...(incarnationId ? { incarnationId } : {})
        })
        runtime?.markPtyLivenessUnverifiable?.(ptyId, SSH_PROVIDER_UNREGISTERED_REASON)
        return false
      }
      return false
    }
    // Why: controller is synchronous, but keep ownership until async shutdown proves whether the provider emitted an exit.
    void shutdownProviderAndDetectExit(provider, ptyId, { immediate: false })
      .then((providerExitObserved) => {
        const retired = retiredRejectedPtyIds.has(ptyId)
        const incarnationId = retired
          ? finishPtyShutdown(ptyId, connectionId, store)
          : finishPtyShutdownAfterExit(runtime, finishPtyShutdown, ptyId, connectionId, store, -1)
        if (!providerExitObserved && !retired) {
          rememberSyntheticKillExit(ptyId)
          sendPtyExitToRenderer({
            id: ptyId,
            code: -1,
            ...(incarnationId ? { incarnationId } : {})
          })
        }
      })
      .catch((err) => {
        const retired = retiredRejectedPtyIds.has(ptyId)
        if (isPtyAlreadyGoneError(err)) {
          const incarnationId = retired
            ? finishPtyShutdown(ptyId, connectionId, store)
            : finishPtyShutdownAfterExit(runtime, finishPtyShutdown, ptyId, connectionId, store, -1)
          if (!retired) {
            rememberSyntheticKillExit(ptyId)
            sendPtyExitToRenderer({
              id: ptyId,
              code: -1,
              ...(incarnationId ? { incarnationId } : {})
            })
          }
          return
        }
        console.warn(
          `[pty] Failed to stop PTY ${ptyId}: ${err instanceof Error ? err.message : String(err)}`
        )
        // Why: close runtime tails without clearing provider ownership, so
        // a retry can still target a PTY that survived the failed shutdown.
        if (!retired) {
          if (connectionId) {
            runtime?.markPtyLivenessUnverifiable?.(
              ptyId,
              err instanceof Error ? err.message : String(err)
            )
          }
          runtime?.onPtyExit(ptyId, -1, ptyIncarnationById.get(ptyId))
        }
        // Outside the `retired` guard: the remote process outlives this client's bookkeeping
        // either way, and the intent is what the next handshake replays.
        recordUndelivered()
      })
    return true
  }
  const startupPromise = getLocalPtyProviderStartupPromise(connectionId)
  if (startupPromise) {
    // Why: select the provider after the daemon swap; the fallback first can report success while orphaning a daemon PTY.
    void startupPromise.then(killWithCurrentProvider).catch((err) => {
      console.warn(
        `[pty] Failed to stop PTY ${ptyId}: ${err instanceof Error ? err.message : String(err)}`
      )
      if (!retiredRejectedPtyIds.has(ptyId)) {
        if (connectionId) {
          runtime?.markPtyLivenessUnverifiable?.(
            ptyId,
            err instanceof Error ? err.message : String(err)
          )
        }
        runtime?.onPtyExit(ptyId, -1, ptyIncarnationById.get(ptyId))
      }
      recordUndelivered()
    })
    return true
  }
  return killWithCurrentProvider()
}

export function retireRejectedPtyFromRuntimeController(
  deps: PtyRuntimeControllerDeps,
  ptyId: string,
  stopConfirmed: boolean
): void {
  const {
    runtime,
    store,
    rememberRetiredRejectedPty,
    rememberSyntheticKillExit,
    sendPtyExitToRenderer,
    finishPtyShutdown
  } = deps
  rememberRetiredRejectedPty(ptyId)
  if (!stopConfirmed) {
    runtime?.markPtyLivenessUnverifiable?.(
      ptyId,
      'a follow-up stop was issued but its outcome could not be verified'
    )
    if (!ptyOwnership.has(ptyId)) {
      return
    }
    runtime?.onPtyExit(ptyId, -1, ptyIncarnationById.get(ptyId))
    rememberSyntheticKillExit(ptyId)
    sendPtyExitToRenderer({
      id: ptyId,
      code: -1,
      ...(ptyIncarnationById.get(ptyId) ? { incarnationId: ptyIncarnationById.get(ptyId) } : {})
    })
    return
  }
  // Why: a completed stop already cleared provider state, tombstoned the lease and told the
  // renderer; repeating that double-fires the exit IPC. The runtime still needs code 0 so an
  // SSH pane retires for good instead of staying preserved by the stop's negative exit.
  if (!ptyOwnership.has(ptyId)) {
    runtime?.onPtyExit(ptyId, 0, ptyIncarnationById.get(ptyId))
    return
  }
  let connectionId: string | null | undefined = ptyOwnership.get(ptyId)
  const parsedSshId = connectionId === undefined ? parseAppSshPtyId(ptyId) : null
  connectionId ??= parsedSshId?.connectionId
  const incarnationId = finishPtyShutdownAfterExit(
    runtime,
    finishPtyShutdown,
    ptyId,
    connectionId,
    store,
    0
  )
  rememberSyntheticKillExit(ptyId)
  sendPtyExitToRenderer({
    id: ptyId,
    code: 0,
    ...(incarnationId ? { incarnationId } : {})
  })
}

export function markReversibleStopsFromRuntimeController(
  deps: PtyRuntimeControllerDeps,
  ptyIds: readonly string[]
): () => void {
  const { reversibleStopOwnersByPtyId } = deps
  for (const ptyId of ptyIds) {
    reversibleStopOwnersByPtyId.set(ptyId, (reversibleStopOwnersByPtyId.get(ptyId) ?? 0) + 1)
  }
  let released = false
  return () => {
    if (released) {
      return
    }
    released = true
    for (const ptyId of ptyIds) {
      const owners = (reversibleStopOwnersByPtyId.get(ptyId) ?? 0) - 1
      if (owners > 0) {
        reversibleStopOwnersByPtyId.set(ptyId, owners)
      } else {
        reversibleStopOwnersByPtyId.delete(ptyId)
      }
    }
  }
}
