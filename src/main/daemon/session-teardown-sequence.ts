import type { PtyStartupIngress } from '../../shared/pty-startup-ingress'
import type { TerminalExitCause } from '../../shared/terminal-exit-cause'
import type { SessionOutputPlane } from './session-output-plane'
import type { SessionProducerPause } from './session-producer-pause'
import type { SessionShellReadyBarrier } from './session-shell-ready-barrier'
import type { SubprocessHandle } from './session-subprocess-handle'
import type { SessionTerminationController } from './session-termination-controller'

/** The collaborators a session tears down. */
export type SessionTeardownParts = {
  subprocess: SubprocessHandle
  output: SessionOutputPlane
  producerPause: SessionProducerPause
  shellReady: SessionShellReadyBarrier
  termination: SessionTerminationController
  startupIngress: PtyStartupIngress
}

/** `Session` keeps ownership of `_state`/`_exitCode`/`_disposed`: the ordering of the teardown
 *  steps around those flips is load-bearing, so they are reached through these callbacks. */
export type SessionTeardownHost = {
  parts: SessionTeardownParts
  incarnationId: string
  isExited: () => boolean
  markExitCode: (code: number) => void
  markExited: () => void
  /** `Session.#teardownSubprocess` — flips `_disposed` before releasing the handle. */
  releaseSubprocess: () => void
}

/** Silences everything that can still push bytes into the emulator: the readiness probe and its
 *  device-attributes responder, the held-byte gate, and the startup-ingress queue. */
export function stopSessionOutputProducers(parts: SessionTeardownParts): void {
  parts.shellReady.releaseDeviceAttributes()
  parts.shellReady.disposePromptReadinessProbe()
  parts.shellReady.releaseHeldBytes()
  parts.startupIngress.drainAndClose()
}

/** Detaches the session from its subprocess handle. Callers own the `_disposed` flip. */
export function releaseSessionSubprocess(host: SessionTeardownHost): void {
  const { parts } = host
  parts.output.markDisposed()
  // Why: never leave a paused fd behind on teardown; the handle's dead-guard makes this a no-op once the child is reaped.
  parts.producerPause.release({ resume: true })
  parts.termination.cancelForceKillFallback()
  parts.shellReady.dispose()
  parts.termination.disposeSubprocessHandle()
}

/** Owner-driven disposal. Callers MUST have checked `_disposed` first. */
export function runSessionDispose(host: SessionTeardownHost): void {
  const { parts } = host
  stopSessionOutputProducers(parts)
  // Why: `wasTerminating` must be read BEFORE the exited flip below — it guards the
  // "dispose while kill() in flight" case and the invariant needs the pre-flip state.
  const wasTerminating = parts.termination.isTerminating && !host.isExited()
  const clientsToNotify = wasTerminating ? parts.output.snapshotClients() : []
  if (wasTerminating) {
    try {
      parts.subprocess.forceKill()
    } catch {
      /* child may already be gone */
    }
    host.markExitCode(-1)
    parts.termination.clearTerminating()
  }

  host.releaseSubprocess()
  host.markExited()

  parts.output.clearClients()
  parts.shellReady.clearPendingWrites()
  parts.output.disposeEmulator()

  for (const client of clientsToNotify) {
    client.onExit(-1, host.incarnationId)
  }
}

/** The child was reaped on its own: quiesce producers, stamp the exit, cancel every timer that
 *  could outlive the session, and free the ptmx fd. Deliberately does NOT go through
 *  `releaseSubprocess` — that flips `_disposed`, short-circuiting the later `Session.dispose()`
 *  reaper. Callers MUST have checked `_disposed` first. */
export function runSessionPhysicalExit(
  host: SessionTeardownHost,
  code: number,
  cause: TerminalExitCause | undefined
): void {
  const { parts } = host
  stopSessionOutputProducers(parts)
  host.markExitCode(code)
  host.markExited()
  parts.termination.clearTerminating()
  // Why resume:false — the child is reaped (nothing to unblock); only the failsafe timer must not outlive the session.
  parts.producerPause.release({ resume: false })
  parts.termination.cancelForceKillFallback()
  parts.shellReady.clearReadyTimer()
  parts.shellReady.clearFlushGate()
  // Why: release the ptmx fd here or node-pty's _socket leaks the master fd until GC (docs/fix-pty-fd-leak.md).
  parts.termination.disposeSubprocessHandle()
  parts.output.broadcastExit(code, host.incarnationId, cause)
}
