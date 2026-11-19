import type { IPtyProvider } from '../../../providers/pty/provider-contract'
import { SSH_PROVIDER_UNREGISTERED_REASON } from '../../../../shared/terminal/pty/lifecycle/pty-liveness-verdict'
import { ptyIncarnationById } from '../provider/ownership-state'
import {
  getProviderForPty,
  getPtySshConnectionId,
  resolvePtyExecutionHost
} from '../provider/registry'
import { delay, isPtyAlreadyGoneError, verifyPtysStopped } from '../provider/liveness'
import type { PtyRuntimeControllerDeps } from './controller-deps'
import { errorMessage } from '../../../../shared/errors/error-message'
import {
  PtyExitProof,
  PtyRetirementWithoutProof
} from '../../../pty/process-retirement/pty-exit-proof'
import {
  isLegacyRelayBridgedPty,
  stopLegacyRelayPaneAndWait
} from '../../../ssh/legacy-relay/bridge/legacy-relay-bridge-registry'
import { OBSERVED_EXIT_RECORD_WAIT_MS, publishSyntheticExit } from './kill'
import type { PtyStopBatchOptions } from '../../../runtime/terminal/lifecycle/runtime-pty-controller-contract'

type PtyStopOptions = { keepHistory?: boolean; deadlineMs?: number }

/** A shut-down PTY whose exit still needs fresh absence from its owning provider. */
type PtyStopAwaitingProof = {
  ptyId: string
  provider: IPtyProvider
  connectionId: string | null
  stoppingIncarnationId: string | undefined
  exitObserved: boolean
}

type PtyStopVerdict = { stopped: boolean } | { error: unknown }

/** Reversible stops must not leave durable kill orders that could destroy a later-woken pane; return failure for retry. */
export async function stopAndWaitPtyFromRuntimeController(
  deps: PtyRuntimeControllerDeps,
  ptyId: string,
  opts?: PtyStopOptions
): Promise<boolean> {
  const verdict = (await stopAndWaitPtys(deps, [ptyId], opts ?? {})).get(ptyId)
  if (verdict && 'error' in verdict) {
    throw verdict.error
  }
  return verdict?.stopped ?? false
}

/** Stops each admitted PTY like `stopAndWaitPtyFromRuntimeController`, but proves the batch's exits
 *  with one provider inventory per round instead of one per PTY. */
export async function stopAndWaitPtysFromRuntimeController(
  deps: PtyRuntimeControllerDeps,
  ptyIds: readonly string[],
  opts: PtyStopBatchOptions
): Promise<Map<string, boolean>> {
  const stopped = new Map<string, boolean>()
  for (const [ptyId, verdict] of await stopAndWaitPtys(deps, ptyIds, opts)) {
    if ('error' in verdict) {
      console.warn(`[pty] Failed to stop PTY ${ptyId}: ${errorMessage(verdict.error)}`)
    }
    stopped.set(ptyId, 'stopped' in verdict && verdict.stopped)
  }
  return stopped
}

async function stopAndWaitPtys(
  deps: PtyRuntimeControllerDeps,
  ptyIds: readonly string[],
  opts: PtyStopBatchOptions
): Promise<Map<string, PtyStopVerdict>> {
  const { keepHistory, deadlineMs, shutdownDeadlineMs = deadlineMs } = opts
  const verdicts = new Map<string, PtyStopVerdict>()
  const relayOwesStop = new Set<string>()
  const awaitingProof: PtyStopAwaitingProof[] = []
  const settle = (ptyId: string, verdict: PtyStopVerdict): void => {
    verdicts.set(ptyId, verdict)
    if (!('stopped' in verdict && verdict.stopped) && !relayOwesStop.has(ptyId)) {
      // Refused, failed or thrown: the process may run on, so it must not read as closing.
      deps.runtime?.clearPtyStopRequest?.(ptyId)
    }
  }
  const pending = [...new Set(ptyIds)]
  let next = 0
  const shutDownNext = async (): Promise<void> => {
    // A batch with a shutdown deadline admits none past it: a kept-history checkpoint outlives its caller.
    while (
      next < pending.length &&
      (opts.shutdownDeadlineMs === undefined || Date.now() < opts.shutdownDeadlineMs)
    ) {
      const ptyId = pending[next++]
      if (opts.admit && !opts.admit(ptyId)) {
        continue
      }
      // A final relay stop is owed until the relay proves it, so an unproven one still reads as closing.
      if (!keepHistory && getPtySshConnectionId(ptyId) && isLegacyRelayBridgedPty(ptyId)) {
        relayOwesStop.add(ptyId)
      }
      try {
        const shutdown = await shutDownPtyForStop(deps, ptyId, {
          keepHistory,
          deadlineMs: shutdownDeadlineMs
        })
        if ('provider' in shutdown) {
          awaitingProof.push(shutdown)
        } else {
          settle(ptyId, shutdown)
        }
      } catch (error) {
        settle(ptyId, { error })
      }
    }
  }
  const workers = Math.max(1, Math.min(opts.concurrency ?? pending.length, pending.length))
  await Promise.all(Array.from({ length: workers }, shutDownNext))
  const byProvider = Map.groupBy(awaitingProof, (stop) => stop.provider)
  await Promise.all(
    [...byProvider].map(([provider, stops]) =>
      proveAndFinishPtyStops(deps, provider, stops, { keepHistory, deadlineMs }, settle)
    )
  )
  return verdicts
}

async function proveAndFinishPtyStops(
  deps: PtyRuntimeControllerDeps,
  provider: IPtyProvider,
  stops: readonly PtyStopAwaitingProof[],
  opts: PtyStopOptions,
  settle: (ptyId: string, verdict: PtyStopVerdict) => void
): Promise<void> {
  const warnUnverified = (unverified: readonly PtyStopAwaitingProof[], err: unknown): void => {
    if (unverified.length === 0) {
      return
    }
    const subject =
      unverified.length === 1 ? `PTY ${unverified[0].ptyId}` : `${unverified.length} PTYs`
    console.warn(`[pty] Failed to verify ${subject} stopped: ${errorMessage(err)}`)
    for (const stop of unverified) {
      settle(stop.ptyId, { stopped: false })
    }
  }
  let proof: Awaited<ReturnType<typeof verifyPtysStopped>>
  try {
    proof = await verifyPtysStopped(provider, stops, opts)
  } catch (err) {
    warnUnverified(stops, err)
    return
  }
  const { stopped: absent, error: pollError } = proof
  // A later round's failure leaves its PTYs unproven; verdicts already proven still stand.
  warnUnverified(
    stops.filter((stop) => !absent.has(stop.ptyId)),
    pollError
  )
  await Promise.all(
    stops.map(async (stop) => {
      const gone = absent.get(stop.ptyId)
      if (gone === undefined) {
        return
      }
      if (!gone) {
        deps.runtime?.markPtyLivenessLive?.(stop.ptyId)
        settle(stop.ptyId, { stopped: false })
        return
      }
      try {
        await finishProvenPtyStop(deps, stop, opts.deadlineMs)
        settle(stop.ptyId, { stopped: true })
      } catch (error) {
        settle(stop.ptyId, { error })
      }
    })
  )
}

async function shutDownPtyForStop(
  deps: PtyRuntimeControllerDeps,
  ptyId: string,
  opts: PtyStopOptions
): Promise<{ stopped: boolean } | PtyStopAwaitingProof> {
  const { runtime, store, getLocalPtyProviderStartupPromise, shutdownProviderAndDetectExit } = deps
  runtime?.markPtyStopRequested?.(ptyId)
  const connectionId = getPtySshConnectionId(ptyId)
  if (connectionId && isLegacyRelayBridgedPty(ptyId)) {
    // A reversible stop must not leave the bridge's durable stop behind, so the pane stays live.
    if (opts.keepHistory) {
      return { stopped: false }
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
      const incarnationId = deps.finishPtyShutdown(ptyId, null, store, proof)
      publishSyntheticExit(publishTo, ptyId, 0, incarnationId, proof)
    }
    return { stopped: stopped !== null }
  }
  // Share one absolute teardown deadline across sequential awaits and RPC leaves.
  const { deadlineMs } = opts
  const startupPromise = getLocalPtyProviderStartupPromise(resolvePtyExecutionHost(ptyId))
  if (startupPromise) {
    // Resolve the provider only after startup; fallback cannot prove daemon teardown.
    if (deadlineMs !== undefined) {
      // Bound startup by teardown budget rather than the longer fail-open startup cap.
      const won = await Promise.race([
        // Rejected startup fails closed and must not leave an unhandled losing promise.
        startupPromise.then(
          () => true,
          () => false
        ),
        delay(Math.max(1, deadlineMs - Date.now())).then(() => false)
      ])
      if (!won) {
        return { stopped: false }
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
      // Missing SSH provider cannot confirm remote exit; retain its tombstoned lease.
      const unproven = PtyRetirementWithoutProof.because(SSH_PROVIDER_UNREGISTERED_REASON)
      const incarnationId = deps.finishPtyShutdown(ptyId, connectionId, store, unproven)
      publishSyntheticExit(deps, ptyId, -1, incarnationId, unproven)
    }
    return { stopped: false }
  }
  const stoppingIncarnationId = ptyIncarnationById.get(ptyId)
  let exitObserved = false
  try {
    exitObserved = await shutdownProviderAndDetectExit(provider, ptyId, {
      immediate: true,
      keepHistory: opts.keepHistory ?? false,
      deadlineMs
    })
  } catch (err) {
    if (!isPtyAlreadyGoneError(err)) {
      console.warn(`[pty] Failed to stop PTY ${ptyId}: ${errorMessage(err)}`)
      return { stopped: false }
    }
  }
  return { ptyId, provider, connectionId, stoppingIncarnationId, exitObserved }
}

async function finishProvenPtyStop(
  deps: PtyRuntimeControllerDeps,
  { ptyId, connectionId, stoppingIncarnationId, exitObserved }: PtyStopAwaitingProof,
  deadlineMs: number | undefined
): Promise<void> {
  const proof = PtyExitProof.from(exitObserved ? 'exit-observed' : 'absent', stoppingIncarnationId)
  const incarnationId = deps.finishPtyShutdown(ptyId, connectionId, deps.store, proof)
  if (!exitObserved) {
    // Fresh owning-provider absence proves exit even if its event was missed.
    publishSyntheticExit(deps, ptyId, 0, incarnationId, proof)
    return
  }
  // SSH exit records follow output drain; wait before returning a verdict consumers can read.
  const waitUntil = Math.min(deadlineMs ?? Infinity, Date.now() + OBSERVED_EXIT_RECORD_WAIT_MS)
  await deps.runtime?.waitForPtyExitRecord?.(ptyId, waitUntil - Date.now())
}
