import type { IPtyProvider } from '../../../providers/types'
import { SSH_PROVIDER_UNREGISTERED_REASON } from '../../../../shared/pty-liveness-verdict'
import { parseAppSshPtyId } from '../../../providers/ssh-pty-id'
import { ptyOwnership } from '../provider/ownership-state'
import { getProvider, getProviderForPty } from '../provider/registry'
import { isPtyAlreadyGoneError, delay, verifyPtyStopped } from '../provider/liveness'
import type { PtyRuntimeControllerDeps } from './controller-deps'
import { finishPtyShutdownAfterExit } from './pty-shutdown-reconciliation'

/**
 * Deliberately records no undelivered-stop intent, unlike `killPtyFromRuntimeController`.
 * Only a caller that gives the PTY up for good may leave a replayable kill order behind.
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
    rememberSyntheticKillExit,
    sendPtyExitToRenderer,
    finishPtyShutdown
  } = deps
  runtime?.markPtyStopRequested?.(ptyId)
  let connectionId: string | null | undefined = ptyOwnership.get(ptyId)
  const parsedSshId = connectionId === undefined ? parseAppSshPtyId(ptyId) : null
  connectionId ??= parsedSshId?.connectionId
  const deadlineMs = opts?.deadlineMs
  const startupPromise = getLocalPtyProviderStartupPromise(connectionId)
  if (startupPromise) {
    if (deadlineMs !== undefined) {
      const won = await Promise.race([
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
      const incarnationId = finishPtyShutdownAfterExit(
        runtime,
        finishPtyShutdown,
        ptyId,
        connectionId,
        store,
        -1
      )
      rememberSyntheticKillExit(ptyId)
      sendPtyExitToRenderer({
        id: ptyId,
        code: -1,
        ...(incarnationId ? { incarnationId } : {})
      })
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
        runtime?.markPtyLivenessUnverifiable?.(
          ptyId,
          err instanceof Error ? err.message : String(err)
        )
      }
      console.warn(
        `[pty] Failed to stop PTY ${ptyId}: ${err instanceof Error ? err.message : String(err)}`
      )
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
      runtime?.markPtyLivenessUnverifiable?.(
        ptyId,
        err instanceof Error ? err.message : String(err)
      )
    }
    console.warn(
      `[pty] Failed to verify PTY ${ptyId} stopped: ${err instanceof Error ? err.message : String(err)}`
    )
    return false
  }
  const incarnationId = providerExitObserved
    ? finishPtyShutdown(ptyId, connectionId, store)
    : finishPtyShutdownAfterExit(runtime, finishPtyShutdown, ptyId, connectionId, store, 0)
  if (!providerExitObserved) {
    // The owning provider's fresh inventory observed absence, so this is a death certificate.
    rememberSyntheticKillExit(ptyId)
    sendPtyExitToRenderer({
      id: ptyId,
      code: 0,
      ...(incarnationId ? { incarnationId } : {})
    })
  }
  return true
}
