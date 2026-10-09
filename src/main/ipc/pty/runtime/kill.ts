import type { IPtyProvider } from '../../../providers/types'
import { SSH_PROVIDER_UNREGISTERED_REASON } from '../../../../shared/pty-liveness-verdict'
import { parseAppSshPtyId } from '../../../providers/ssh-pty-id'
import { ptyOwnership, ptyIncarnationById } from '../provider/ownership-state'
import { getProvider, getProviderForPty } from '../provider/registry'
import { isPtyAlreadyGoneError, delay, verifyPtyStopped } from '../provider/liveness'
import { recordUndeliveredSshPtyKill } from './undelivered-ssh-kill'
import type { PtyRuntimeControllerDeps } from './controller-deps'
import { errorMessage } from '../../../../shared/error-message'

// Bounds the wait for an observed exit to reach the runtime record when the caller set no deadline.
const OBSERVED_EXIT_RECORD_WAIT_MS = 10_000

function resolvePtyConnectionId(ptyId: string): string | null | undefined {
  const owned = ptyOwnership.get(ptyId)
  return owned !== undefined ? owned : parseAppSshPtyId(ptyId)?.connectionId
}

function publishSyntheticExit(
  deps: PtyRuntimeControllerDeps,
  ptyId: string,
  code: number,
  incarnationId: string | undefined
): void {
  deps.runtime?.onPtyExit(ptyId, code, incarnationId)
  deps.rememberSyntheticKillExit(ptyId, incarnationId)
  deps.sendPtyExitToRenderer({ id: ptyId, code, ...(incarnationId ? { incarnationId } : {}) })
}

export function killPtyFromRuntimeController(
  deps: PtyRuntimeControllerDeps,
  ptyId: string
): boolean {
  const {
    runtime,
    store,
    getLocalPtyProviderStartupPromise,
    shutdownProviderAndDetectExit,
    finishPtyShutdown,
    retiredRejectedPtyIds
  } = deps
  runtime?.markPtyStopRequested?.(ptyId)
  const connectionId = resolvePtyConnectionId(ptyId)
  const recordUndelivered = (incarnationId?: string): void => {
    recordUndeliveredSshPtyKill({
      store,
      ptyId,
      connectionId,
      reversible: runtime?.intentionalPtyStops?.isReversibleStopInFlight(ptyId) ?? false,
      incarnationId
    })
  }
  // Why: close runtime tails without clearing provider ownership, so
  // a retry can still target a PTY that survived the failed shutdown.
  const reportStopFailure = (err: unknown): void => {
    const msg = errorMessage(err)
    console.warn(`[pty] Failed to stop PTY ${ptyId}: ${msg}`)
    if (retiredRejectedPtyIds.has(ptyId)) {
      return
    }
    if (connectionId) {
      runtime?.markPtyLivenessUnverifiable?.(ptyId, msg)
    }
    runtime?.onPtyExit(ptyId, -1, ptyIncarnationById.get(ptyId))
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
        const incarnationId = finishPtyShutdown(ptyId, connectionId, store)
        // The relay was never asked, so the remote shell is still running. Keep the order.
        recordUndelivered(incarnationId)
        publishSyntheticExit(deps, ptyId, -1, incarnationId)
        runtime?.markPtyLivenessUnverifiable?.(ptyId, SSH_PROVIDER_UNREGISTERED_REASON)
        return false
      }
      return false
    }
    // Why: controller is synchronous, but keep ownership until async shutdown proves whether the provider emitted an exit.
    void shutdownProviderAndDetectExit(provider, ptyId, { immediate: false })
      .then((providerExitObserved) => {
        const retired = retiredRejectedPtyIds.has(ptyId)
        const incarnationId = finishPtyShutdown(ptyId, connectionId, store)
        if (!providerExitObserved && !retired) {
          publishSyntheticExit(deps, ptyId, -1, incarnationId)
        }
      })
      .catch((err) => {
        const retired = retiredRejectedPtyIds.has(ptyId)
        if (isPtyAlreadyGoneError(err)) {
          const incarnationId = finishPtyShutdown(ptyId, connectionId, store)
          if (!retired) {
            publishSyntheticExit(deps, ptyId, -1, incarnationId)
          }
          return
        }
        reportStopFailure(err)
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
      reportStopFailure(err)
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
  const { runtime, store, rememberRetiredRejectedPty, finishPtyShutdown } = deps
  rememberRetiredRejectedPty(ptyId)
  if (!stopConfirmed) {
    runtime?.markPtyLivenessUnverifiable?.(
      ptyId,
      'a follow-up stop was issued but its outcome could not be verified'
    )
    if (!ptyOwnership.has(ptyId)) {
      return
    }
    publishSyntheticExit(deps, ptyId, -1, ptyIncarnationById.get(ptyId))
    return
  }
  // Why: a completed stop already cleared provider state, tombstoned the lease and told the
  // renderer; repeating that double-fires the exit IPC. The runtime still needs code 0 so an
  // SSH pane retires for good instead of staying preserved by the stop's negative exit.
  if (!ptyOwnership.has(ptyId)) {
    runtime?.onPtyExit(ptyId, 0, ptyIncarnationById.get(ptyId))
    return
  }
  const connectionId = resolvePtyConnectionId(ptyId)
  publishSyntheticExit(deps, ptyId, 0, finishPtyShutdown(ptyId, connectionId, store))
}

/**
 * Deliberately records no undelivered-stop intent, unlike `killPtyFromRuntimeController`.
 *
 * Only a caller that gives the PTY up for good may leave a replayable kill order behind. This one
 * hands its failures back instead: worktree sleep marks these stops reversible and leaves the pane
 * live and usable when one does not land, so a durable order recorded here would come back on a
 * later handshake and destroy a terminal the user had gone back to using.
 */
export async function stopAndWaitPtyFromRuntimeController(
  deps: PtyRuntimeControllerDeps,
  ptyId: string,
  opts?: { keepHistory?: boolean; deadlineMs?: number }
): Promise<boolean> {
  const {
    runtime,
    store,
    getLocalPtyProviderStartupPromise,
    shutdownProviderAndDetectExit,
    finishPtyShutdown
  } = deps
  runtime?.markPtyStopRequested?.(ptyId)
  const connectionId = resolvePtyConnectionId(ptyId)
  // Why: destructive teardown threads one absolute deadline through every await
  // below; each RPC leaf converts it to the remaining time when it issues, so
  // sequential RPCs share the budget and cannot overrun the sweep deadline.
  const deadlineMs = opts?.deadlineMs
  const startupPromise = getLocalPtyProviderStartupPromise(connectionId)
  if (startupPromise) {
    // Why: exact-stop must resolve the provider after daemon startup just
    // like renderer kills, or the fallback can falsely confirm teardown.
    if (deadlineMs !== undefined) {
      // Why: bound the cold-start await by the teardown deadline instead of the
      // 60s startup fail-open cap; fail closed so the sweep records the miss.
      const won = await Promise.race([
        // Why: () => false on rejection both fails closed on a startup error and
        // keeps the losing branch's rejection from surfacing as unhandled.
        startupPromise.then(
          () => true,
          () => false
        ),
        delay(Math.max(1, deadlineMs - Date.now())).then(() => false)
      ])
      if (!won) {
        return false
      }
    } else {
      await startupPromise
    }
  }
  let provider: IPtyProvider
  try {
    provider = connectionId ? getProvider(connectionId) : getProviderForPty(ptyId)
  } catch {
    if (connectionId) {
      // Why: an absent SSH provider means there is no live target left to
      // await, but the relay lease must still be tombstoned.
      const incarnationId = finishPtyShutdown(ptyId, connectionId, store)
      publishSyntheticExit(deps, ptyId, -1, incarnationId)
      runtime?.markPtyLivenessUnverifiable?.(ptyId, SSH_PROVIDER_UNREGISTERED_REASON)
    }
    return false
  }
  let providerExitObserved = false
  try {
    providerExitObserved = await shutdownProviderAndDetectExit(provider, ptyId, {
      immediate: true,
      keepHistory: opts?.keepHistory ?? false,
      deadlineMs
    })
  } catch (err) {
    if (!isPtyAlreadyGoneError(err)) {
      if (connectionId) {
        runtime?.markPtyLivenessUnverifiable?.(ptyId, errorMessage(err))
      }
      console.warn(`[pty] Failed to stop PTY ${ptyId}: ${errorMessage(err)}`)
      return false
    }
  }
  try {
    if (!(await verifyPtyStopped(provider, ptyId, opts))) {
      runtime?.markPtyLivenessLive?.(ptyId)
      return false
    }
  } catch (err) {
    if (connectionId) {
      runtime?.markPtyLivenessUnverifiable?.(ptyId, errorMessage(err))
    }
    console.warn(`[pty] Failed to verify PTY ${ptyId} stopped: ${errorMessage(err)}`)
    return false
  }
  const incarnationId = finishPtyShutdown(ptyId, connectionId, store)
  if (!providerExitObserved) {
    // The owning provider's fresh inventory observed absence, so this is a
    // death certificate even when its exit event was missed.
    publishSyntheticExit(deps, ptyId, 0, incarnationId)
  } else {
    // Why: an SSH exit frame reaches the runtime only after its output intake drains, so callers
    // reading the verdict right after this stop would otherwise see a still-connected PTY.
    const waitUntil = Math.min(deadlineMs ?? Infinity, Date.now() + OBSERVED_EXIT_RECORD_WAIT_MS)
    await runtime?.waitForPtyExitRecord?.(ptyId, waitUntil - Date.now())
  }
  return true
}
