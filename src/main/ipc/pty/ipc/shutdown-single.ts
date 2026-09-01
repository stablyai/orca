import type { Store } from '../../../persistence'
import type { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import type { IPtyProvider } from '../../../providers/types'
import { parseAppSshPtyId } from '../../../providers/ssh-pty-id'
import { SSH_PROVIDER_UNREGISTERED_REASON } from '../../../../shared/pty-liveness-verdict'
import { ptyOwnership } from '../provider/ownership-state'
import { getProviderForPty, sshProviders, tryGetProviderForPty } from '../provider/registry'
import { finishPtyShutdown, isPtyAlreadyGoneError } from '../provider/liveness'
import { recordUndeliveredSshPtyKill } from '../runtime/undelivered-ssh-kill'
import { shutdownProviderAndDetectOutcome } from '../provider/shutdown-detect'
import type { PtyKillIntent } from '../../../../shared/pty-kill-sessions'
import type { PtyShutdownResult } from '../../../providers/pty-provider-contract'

export type SinglePtyKillDeps = {
  store?: Store
  runtime?: OrcaRuntimeService
  getLocalPtyProviderStartupPromise: (connectionId?: string | null) => Promise<void> | undefined
  rememberSyntheticKillExit: (id: string) => void
  sendPtyExitToRenderer: (payload: { id: string; code: number; incarnationId?: string }) => void
}

export async function shutdownSinglePty(
  args: {
    id: string
    keepHistory?: boolean
    intent?: PtyKillIntent
    incarnationId?: string
    provider?: IPtyProvider
  },
  deps: SinglePtyKillDeps
): Promise<PtyShutdownResult | void> {
  const { id } = args
  deps.runtime?.markPtyStopRequested?.(id)
  const ownedConnectionId = ptyOwnership.get(id)
  const parsedSshId = ownedConnectionId === undefined ? parseAppSshPtyId(id) : null
  const connectionId = ownedConnectionId ?? parsedSshId?.connectionId
  const startupPromise = deps.getLocalPtyProviderStartupPromise(connectionId)
  if (startupPromise) {
    await startupPromise
  }
  const reversible = args.keepHistory === true
  const provider =
    args.provider ?? (connectionId ? sshProviders.get(connectionId) : tryGetProviderForPty(id))
  if (!provider && connectionId) {
    if (args.intent === 'orphan-cleanup') {
      // Losing the provider is not evidence that a remote PTY exited; preserve the
      // lease and let the next handshake replay the fenced stop.
      recordUndeliveredSshPtyKill({
        store: deps.store,
        ptyId: id,
        connectionId,
        reversible
      })
      deps.runtime?.clearPtyStopRequested?.(id)
      deps.runtime?.markPtyLivenessUnverifiable?.(id, SSH_PROVIDER_UNREGISTERED_REASON)
      return
    }
    const incarnationId = finishPtyShutdown(id, connectionId, deps.store)
    recordUndeliveredSshPtyKill({
      store: deps.store,
      ptyId: id,
      connectionId,
      reversible,
      incarnationId
    })
    deps.runtime?.markPtyLivenessUnverifiable?.(id, SSH_PROVIDER_UNREGISTERED_REASON)
    deps.runtime?.onPtyExit(id, -1, incarnationId)
    deps.rememberSyntheticKillExit(id)
    deps.sendPtyExitToRenderer({ id, code: -1, ...(incarnationId ? { incarnationId } : {}) })
    return
  }
  const shutdownProvider = provider ?? getProviderForPty(id)
  let providerExitObserved = false
  let result: PtyShutdownResult | void = undefined
  try {
    const shutdownOpts = {
      immediate: true,
      keepHistory: args.keepHistory ?? false,
      ...(args.intent ? { intent: args.intent } : {}),
      ...(args.incarnationId ? { incarnationId: args.incarnationId } : {})
    }
    const detected = await shutdownProviderAndDetectOutcome(shutdownProvider, id, shutdownOpts)
    providerExitObserved = detected.providerExitObserved
    result = detected.result
    // A pending daemon teardown can reject a stale incarnation without throwing.
    // Keep client ownership intact until bulk verification classifies that refusal.
    if (result?.fenceUnavailable) {
      deps.runtime?.clearPtyStopRequested?.(id)
      return result
    }
  } catch (err) {
    if (!isPtyAlreadyGoneError(err)) {
      recordUndeliveredSshPtyKill({ store: deps.store, ptyId: id, connectionId, reversible })
      throw err
    }
  }
  const incarnationId = finishPtyShutdown(id, connectionId, deps.store)
  if (!providerExitObserved) {
    deps.runtime?.onPtyExit(id, -1, incarnationId)
    deps.rememberSyntheticKillExit(id)
    deps.sendPtyExitToRenderer({ id, code: -1, ...(incarnationId ? { incarnationId } : {}) })
  }
  return result
}
