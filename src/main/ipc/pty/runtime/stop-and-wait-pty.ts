import type { IPtyProvider } from '../../../providers/types'
import { SSH_PROVIDER_UNREGISTERED_REASON } from '../../../../shared/pty-liveness-verdict'
import type { PtyStopReceipt } from '../../../../shared/pty-stop-receipt'
import { parseAppSshPtyId } from '../../../providers/ssh-pty-id'
import { ptyOwnership } from '../provider/ownership-state'
import { getProvider, getProviderForPty } from '../provider/registry'
import { delay, isPtyAlreadyGoneError } from '../provider/liveness'
import type { PtyRuntimeControllerDeps } from './controller-deps'

export async function stopAndWaitPtyFromRuntimeController(
  deps: PtyRuntimeControllerDeps,
  ptyId: string,
  opts?: { keepHistory?: boolean; deadlineMs?: number }
): Promise<PtyStopReceipt | null> {
  // Reversible sleep stops return failures instead of persisting a kill that could destroy a reused pane.
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
        return null
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
      const incarnationId = finishPtyShutdown(ptyId, connectionId, store)
      runtime?.onPtyExit(ptyId, -1, incarnationId)
      rememberSyntheticKillExit(ptyId)
      sendPtyExitToRenderer({
        id: ptyId,
        code: -1,
        ...(incarnationId ? { incarnationId } : {})
      })
      runtime?.markPtyLivenessUnverifiable?.(ptyId, SSH_PROVIDER_UNREGISTERED_REASON)
    }
    return null
  }
  let receipt: PtyStopReceipt
  let providerExitObserved = false
  try {
    const stopResult = await shutdownProviderAndDetectExit(provider, ptyId, {
      immediate: true,
      keepHistory: opts?.keepHistory ?? false,
      deadlineMs
    })
    receipt = stopResult.receipt
    providerExitObserved = stopResult.providerExitObserved
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
    }
    return null
  }
  if (receipt.verdict === 'live') {
    runtime?.markPtyLivenessLive?.(ptyId)
    return receipt
  }
  if (receipt.verdict !== 'exited' || !receipt.processTreeVerified) {
    runtime?.markPtyLivenessUnverifiable?.(ptyId, receipt.reason)
    return receipt
  }
  const incarnationId = finishPtyShutdown(ptyId, connectionId, store)
  if (!providerExitObserved) {
    runtime?.onPtyExit(ptyId, 0, incarnationId)
    rememberSyntheticKillExit(ptyId)
    sendPtyExitToRenderer({
      id: ptyId,
      code: 0,
      ...(incarnationId ? { incarnationId } : {})
    })
  }
  return receipt
}
