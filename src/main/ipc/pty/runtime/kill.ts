import type { IPtyProvider } from '../../../providers/pty-provider-contract'
import { SSH_PROVIDER_UNREGISTERED_REASON } from '../../../../shared/pty-liveness-verdict'
import { isCurrentPtyExit, ptyOwnership, ptyIncarnationById } from '../provider/ownership-state'
import {
  getProviderForPty,
  getPtySshConnectionId,
  resolvePtyExecutionHost
} from '../provider/registry'
import { isPtyAlreadyGoneError, delay, verifyPtyStopped } from '../provider/liveness'
import type { PtyRuntimeControllerDeps } from './controller-deps'
import type { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import { errorMessage } from '../../../../shared/error-message'
import {
  PtyExitProof,
  PtyRetirementWithoutProof,
  type PtyRetirementEvidence
} from '../../../pty-exit-proof'
import {
  closeLegacyRelayPane,
  isLegacyRelayBridgedPty,
  stopLegacyRelayPaneAndWait
} from '../../../ssh/legacy-relay/legacy-relay-bridge-registry'

// Bounds the wait for an observed exit to reach the runtime record when the caller set no deadline.
const OBSERVED_EXIT_RECORD_WAIT_MS = 10_000

/** Tells the runtime and renderer a PTY ended that no provider exit reported. Without proof its
 *  liveness reads `unverifiable`, never `exited`. A `null` incarnation (a proof
 *  `finishPtyShutdown` refused) publishes nothing: the id belongs to a respawn now. */
export function publishSyntheticExit(
  deps: Pick<PtyRuntimeControllerDeps, 'rememberSyntheticKillExit' | 'sendPtyExitToRenderer'> & {
    runtime?: Pick<OrcaRuntimeService, 'onPtyExit' | 'markPtyLivenessUnverifiable'>
  },
  ptyId: string,
  code: number,
  incarnationId: string | undefined | null,
  evidence: PtyRetirementEvidence
): void {
  if (incarnationId === null) {
    return
  }
  if (evidence instanceof PtyRetirementWithoutProof) {
    deps.runtime?.markPtyLivenessUnverifiable?.(ptyId, evidence.unverifiableReason)
  }
  deps.runtime?.onPtyExit(ptyId, code, incarnationId)
  deps.rememberSyntheticKillExit(ptyId, incarnationId)
  deps.sendPtyExitToRenderer({ id: ptyId, code, ...(incarnationId ? { incarnationId } : {}) })
}

/**
 * COMPAT(legacy-relay-bridge, revisit 2027-01-15): an older relay's shell stops through the
 * bridge, which retires its lease only on the relay's proof; tombstoning it here would orphan it.
 * Every stop route checks this first, before reading the (absent) SSH provider. A reversible stop
 * is refused: the bridge's recorded stop would outlive it and kill a shell the pane wakes back to.
 */
export function stopLegacyRelayBridgedPty(
  ptyId: string,
  connectionId: string | null,
  reversible = false
): Promise<unknown> | null {
  if (!connectionId || !isLegacyRelayBridgedPty(ptyId)) {
    return null
  }
  return reversible
    ? Promise.reject(new Error('legacy_relay_bridged_pty_cannot_sleep'))
    : closeLegacyRelayPane(ptyId)
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
  const connectionId = getPtySshConnectionId(ptyId)
  if (stopLegacyRelayBridgedPty(ptyId, connectionId)) {
    return true
  }
  // Why: close runtime tails without clearing provider ownership, so
  // a retry can still target a PTY that survived the failed shutdown.
  const reportStopFailure = (err: unknown, incarnationId: string | undefined): void => {
    const msg = errorMessage(err)
    console.warn(`[pty] Failed to stop PTY ${ptyId}: ${msg}`)
    if (retiredRejectedPtyIds.has(ptyId)) {
      return
    }
    runtime?.onPtyExit(ptyId, -1, incarnationId)
  }
  const killWithCurrentProvider = (): boolean => {
    let provider: IPtyProvider
    try {
      provider = getProviderForPty(ptyId)
    } catch {
      if (connectionId) {
        // Why: runtime/CLI close can target a detached SSH PTY after its
        // provider was unregistered. Tombstone the lease so reconnect does
        // not revive a terminal the user explicitly closed.
        const unproven = PtyRetirementWithoutProof.because(SSH_PROVIDER_UNREGISTERED_REASON)
        const incarnationId = finishPtyShutdown(ptyId, connectionId, store, unproven)
        publishSyntheticExit(deps, ptyId, -1, incarnationId, unproven)
      }
      return false
    }
    const stoppingIncarnationId = ptyIncarnationById.get(ptyId)
    // Why: controller is synchronous, but keep ownership until async shutdown proves whether the provider emitted an exit.
    void shutdownProviderAndDetectExit(provider, ptyId, { immediate: false })
      .then((providerExitObserved) => {
        const retired = retiredRejectedPtyIds.has(ptyId)
        const proof = PtyExitProof.from(
          providerExitObserved ? 'exit-observed' : 'shutdown-acknowledged',
          stoppingIncarnationId
        )
        const incarnationId = finishPtyShutdown(ptyId, connectionId, store, proof)
        if (!providerExitObserved && !retired) {
          publishSyntheticExit(deps, ptyId, -1, incarnationId, proof)
        }
      })
      .catch((err) => {
        const retired = retiredRejectedPtyIds.has(ptyId)
        if (isPtyAlreadyGoneError(err)) {
          const proof = PtyExitProof.from('absent', stoppingIncarnationId)
          const incarnationId = finishPtyShutdown(ptyId, connectionId, store, proof)
          if (!retired) {
            publishSyntheticExit(deps, ptyId, -1, incarnationId, proof)
          }
          return
        }
        reportStopFailure(err, stoppingIncarnationId)
      })
    return true
  }
  const killedIncarnationId = ptyIncarnationById.get(ptyId)
  const startupPromise = getLocalPtyProviderStartupPromise(resolvePtyExecutionHost(ptyId))
  if (startupPromise) {
    // Why: select the provider after the daemon swap; the fallback first can report success while orphaning a daemon PTY.
    void startupPromise
      .then(killWithCurrentProvider)
      .catch((err) => reportStopFailure(err, killedIncarnationId))
    return true
  }
  return killWithCurrentProvider()
}

export function retireRejectedPtyFromRuntimeController(
  deps: PtyRuntimeControllerDeps,
  ptyId: string,
  stopConfirmed: boolean,
  incarnationId: string | undefined
): void {
  const { runtime, store, rememberRetiredRejectedPty, finishPtyShutdown } = deps
  // A same-id respawn owns the record now; this verdict is about the rejected incarnation only.
  if (!isCurrentPtyExit({ id: ptyId, incarnationId })) {
    return
  }
  rememberRetiredRejectedPty(ptyId)
  if (!stopConfirmed) {
    const unproven = PtyRetirementWithoutProof.because(
      'a follow-up stop was issued but its outcome could not be verified'
    )
    if (!ptyOwnership.has(ptyId)) {
      runtime?.markPtyLivenessUnverifiable?.(ptyId, unproven.unverifiableReason)
      return
    }
    publishSyntheticExit(deps, ptyId, -1, incarnationId, unproven)
    return
  }
  // Why: a completed stop already cleared provider state, tombstoned the lease and told the
  // renderer; repeating that double-fires the exit IPC. The runtime still needs code 0 so an
  // SSH pane retires for good instead of staying preserved by the stop's negative exit.
  if (!ptyOwnership.has(ptyId)) {
    runtime?.onPtyExit(ptyId, 0, incarnationId)
    return
  }
  const proof = PtyExitProof.from('stop-confirmed', incarnationId)
  const connectionId = getPtySshConnectionId(ptyId)
  publishSyntheticExit(deps, ptyId, 0, finishPtyShutdown(ptyId, connectionId, store, proof), proof)
}

/**
 * Deliberately records no undelivered-stop intent, unlike `killPtyFromRuntimeController`, except
 * the legacy relay bridge's for a non-reversible stop (the tab is given up for good).
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
  const connectionId = getPtySshConnectionId(ptyId)
  if (connectionId && isLegacyRelayBridgedPty(ptyId)) {
    // A reversible stop must not leave the bridge's durable stop behind, so the pane stays live.
    if (opts?.keepHistory) {
      return false
    }
    const stoppingIncarnationId = ptyIncarnationById.get(ptyId)
    const deadline = opts?.deadlineMs ?? Date.now() + OBSERVED_EXIT_RECORD_WAIT_MS
    const stopped = await Promise.race([
      stopLegacyRelayPaneAndWait(ptyId, deadline),
      delay(Math.max(1, deadline - Date.now())).then(() => null)
    ])
    if (stopped) {
      // The bridge retired the lease and holds no pane. An exit it saw already reached the runtime.
      const proof = PtyExitProof.from('absent', stoppingIncarnationId)
      const publishTo = stopped === 'reported' ? { ...deps, runtime: undefined } : deps
      publishSyntheticExit(publishTo, ptyId, 0, finishPtyShutdown(ptyId, null, store, proof), proof)
    }
    return stopped !== null
  }
  // Why: destructive teardown threads one absolute deadline through every await
  // below; each RPC leaf converts it to the remaining time when it issues, so
  // sequential RPCs share the budget and cannot overrun the sweep deadline.
  const deadlineMs = opts?.deadlineMs
  const startupPromise = getLocalPtyProviderStartupPromise(resolvePtyExecutionHost(ptyId))
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
    provider = getProviderForPty(ptyId)
  } catch {
    if (connectionId) {
      // Why: an absent SSH provider means there is no live target left to
      // await, but the relay lease must still be tombstoned.
      const unproven = PtyRetirementWithoutProof.because(SSH_PROVIDER_UNREGISTERED_REASON)
      const incarnationId = finishPtyShutdown(ptyId, connectionId, store, unproven)
      publishSyntheticExit(deps, ptyId, -1, incarnationId, unproven)
    }
    return false
  }
  const stoppingIncarnationId = ptyIncarnationById.get(ptyId)
  let providerExitObserved = false
  try {
    providerExitObserved = await shutdownProviderAndDetectExit(provider, ptyId, {
      immediate: true,
      keepHistory: opts?.keepHistory ?? false,
      deadlineMs
    })
  } catch (err) {
    if (!isPtyAlreadyGoneError(err)) {
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
    console.warn(`[pty] Failed to verify PTY ${ptyId} stopped: ${errorMessage(err)}`)
    return false
  }
  const proof = PtyExitProof.from(
    providerExitObserved ? 'exit-observed' : 'absent',
    stoppingIncarnationId
  )
  const incarnationId = finishPtyShutdown(ptyId, connectionId, store, proof)
  if (!providerExitObserved) {
    // The owning provider's fresh inventory observed absence, so this is a
    // death certificate even when its exit event was missed.
    publishSyntheticExit(deps, ptyId, 0, incarnationId, proof)
  } else {
    // Why: an SSH exit frame reaches the runtime only after its output intake drains, so callers
    // reading the verdict right after this stop would otherwise see a still-connected PTY.
    const waitUntil = Math.min(deadlineMs ?? Infinity, Date.now() + OBSERVED_EXIT_RECORD_WAIT_MS)
    await runtime?.waitForPtyExitRecord?.(ptyId, waitUntil - Date.now())
  }
  return true
}
