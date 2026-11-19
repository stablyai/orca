import type { IPtyProvider } from '../../../providers/pty/provider-contract'
import { SSH_PROVIDER_UNREGISTERED_REASON } from '../../../../shared/terminal/pty/lifecycle/pty-liveness-verdict'
import { isCurrentPtyExit, ptyOwnership, ptyIncarnationById } from '../provider/ownership-state'
import {
  getProviderForPty,
  getPtySshConnectionId,
  resolvePtyExecutionHost
} from '../provider/registry'
import { delay, isPtyAlreadyGoneError } from '../provider/liveness'
import type { PtyRuntimeControllerDeps } from './controller-deps'
import type { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import { errorMessage } from '../../../../shared/errors/error-message'
import {
  PtyExitProof,
  PtyRetirementWithoutProof,
  type PtyRetirementEvidence
} from '../../../pty/process-retirement/pty-exit-proof'
import {
  closeLegacyRelayPane,
  isLegacyRelayBridgedPty,
  stopLegacyRelayPaneAndWait
} from '../../../ssh/legacy-relay/bridge/legacy-relay-bridge-registry'

// Bounds the wait for an observed exit to reach the runtime record when the caller set no deadline.
export const OBSERVED_EXIT_RECORD_WAIT_MS = 10_000

/** Unproved synthetic exit stays unverifiable; rejected incarnation proof publishes nothing for a same-ID respawn. */
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

/** A PTY whose SSH provider is gone cannot prove its remote exit: retire its tombstoned lease. */
export function retireSshPtyWithoutProvider(
  deps: PtyRuntimeControllerDeps,
  ptyId: string,
  connectionId: string
): void {
  const unproven = PtyRetirementWithoutProof.because(SSH_PROVIDER_UNREGISTERED_REASON)
  const incarnationId = deps.finishPtyShutdown(ptyId, connectionId, deps.store, unproven)
  publishSyntheticExit(deps, ptyId, -1, incarnationId, unproven)
}

/** Whether a final stop of this PTY is owed through the legacy relay bridge until it proves it. */
export function legacyRelayOwesStop(ptyId: string, keepHistory: boolean | undefined): boolean {
  return !keepHistory && Boolean(getPtySshConnectionId(ptyId)) && isLegacyRelayBridgedPty(ptyId)
}

/** Stops a legacy-relay-bridged PTY and waits for the bridge's proof; null when not bridged. */
export async function stopLegacyRelayBridgedPtyAndWait(
  deps: PtyRuntimeControllerDeps,
  ptyId: string,
  opts: { keepHistory?: boolean; deadlineMs?: number }
): Promise<boolean | null> {
  if (!getPtySshConnectionId(ptyId) || !isLegacyRelayBridgedPty(ptyId)) {
    return null
  }
  // A reversible stop must not leave the bridge's durable stop behind, so the pane stays live.
  if (opts.keepHistory) {
    return false
  }
  const stoppingIncarnationId = ptyIncarnationById.get(ptyId)
  const deadline = opts.deadlineMs ?? Date.now() + OBSERVED_EXIT_RECORD_WAIT_MS
  const stopped = await Promise.race([
    stopLegacyRelayPaneAndWait(ptyId, deadline),
    delay(Math.max(1, deadline - Date.now())).then(() => null)
  ])
  if (stopped) {
    // The bridge retired the lease and holds no pane. An exit it saw already reached the runtime.
    const proof = PtyExitProof.from('absent', stoppingIncarnationId)
    const publishTo = stopped === 'reported' ? { ...deps, runtime: undefined } : deps
    const incarnationId = deps.finishPtyShutdown(ptyId, null, deps.store, proof)
    publishSyntheticExit(publishTo, ptyId, 0, incarnationId, proof)
  }
  return stopped !== null
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
  // Close runtime tails but retain provider ownership so failed shutdown can be retried.
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
        // Detached SSH close must tombstone the lease so reconnect cannot revive a user-closed pane.
        retireSshPtyWithoutProvider(deps, ptyId, connectionId)
      }
      return false
    }
    const stoppingIncarnationId = ptyIncarnationById.get(ptyId)
    // The synchronous controller retains ownership until asynchronous shutdown settles.
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
    // Select after daemon handoff; fallback shutdown can falsely succeed while orphaning a daemon PTY.
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
  // Avoid duplicate renderer exits, but finalize runtime exit so a permanently closed SSH pane is not preserved.
  if (!ptyOwnership.has(ptyId)) {
    runtime?.onPtyExit(ptyId, 0, incarnationId)
    return
  }
  const proof = PtyExitProof.from('stop-confirmed', incarnationId)
  const connectionId = getPtySshConnectionId(ptyId)
  publishSyntheticExit(deps, ptyId, 0, finishPtyShutdown(ptyId, connectionId, store, proof), proof)
}
