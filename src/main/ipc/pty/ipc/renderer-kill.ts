import type {
  PtyFencedTerminationRequest,
  PtyFencedTerminationOutcome
} from '../../../../shared/pty-fenced-termination'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import { isRemoteRuntimePtyId } from '../../../../shared/remote-runtime-pty-id'
import { getPtyIpc } from '../../pty-host-bindings'
import type { Store } from '../../../persistence'
import type { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import type { TerminalIntentionalStopKind } from '../../../runtime/terminal-intentional-stops'
import type { IPtyProvider } from '../../../providers/pty-provider-contract'
import { SSH_PROVIDER_UNREGISTERED_REASON } from '../../../../shared/pty-liveness-verdict'
import { ptyIncarnationById } from '../provider/ownership-state'
import {
  getProviderForPty,
  getPtySshConnectionId,
  resolvePtyExecutionHost,
  tryGetProviderForPty,
  type ResolvedPtyHost
} from '../provider/registry'
import { finishPtyShutdown, isPtyAlreadyGoneError } from '../provider/liveness'
import { publishSyntheticExit, stopLegacyRelayBridgedPty } from '../runtime/kill'
import { PtyExitProof, PtyRetirementWithoutProof } from '../../../pty-exit-proof'

export type PtyKillIpcDeps = {
  store?: Store
  runtime?: OrcaRuntimeService
  getLocalPtyProviderStartupPromise: (hostId?: ResolvedPtyHost) => Promise<void> | undefined
  shutdownProviderAndDetectExit: (
    provider: IPtyProvider,
    id: string,
    opts: { immediate?: boolean; keepHistory?: boolean; deadlineMs?: number }
  ) => Promise<boolean>
  rememberSyntheticKillExit: (id: string, incarnationId?: string) => void
  sendPtyExitToRenderer: (payload: { id: string; code: number; incarnationId?: string }) => void
}

/** `pty:kill` — the route the renderer takes when the user closes a terminal tab, and a separate
 *  implementation from `killPtyFromRuntimeController`. */
export function installPtyKillIpcHandler(deps: PtyKillIpcDeps): void {
  getPtyIpc().handle('pty:kill', (_event, args: { id: string; keepHistory?: boolean }) =>
    stopRendererOwnedPty(deps, args)
  )
  getPtyIpc().handle('pty:killFenced', (_event, args: PtyFencedTerminationRequest | undefined) =>
    stopFencedRendererPty(deps, args)
  )
}

/** Stops a pane's PTY for the spawn replacing it. The stop register labels the exit so the
 *  renderer reads it as a handoff, not the pane dying; a failed stop leaves no label. */
export async function stopReplacedPanePty(deps: PtyKillIpcDeps, id: string): Promise<void> {
  await stopRendererOwnedPtyAs(deps, { id }, 'replaced')
}

/** Stops a renderer-owned PTY and settles only once its shutdown has been observed or synthesized. */
export async function stopRendererOwnedPty(
  deps: PtyKillIpcDeps,
  args: { id: string; keepHistory?: boolean }
): Promise<void> {
  // Why: only hibernation passes keepHistory, and its exit must keep the pane's wake binding.
  await stopRendererOwnedPtyAs(deps, args, args?.keepHistory === true ? 'reversible' : null)
}

async function stopRendererOwnedPtyAs(
  deps: PtyKillIpcDeps,
  args: { id: string; keepHistory?: boolean },
  intentionalStop: TerminalIntentionalStopKind | null
): Promise<void> {
  if (typeof args?.id !== 'string' || !args.id || isRemoteRuntimePtyId(args.id)) {
    // Why: runtime terminal handles belong to terminal.close; unowned PTY routing could target the local provider.
    throw new Error('Invalid PTY provider id')
  }
  const settleStop = intentionalStop
    ? deps.runtime?.intentionalPtyStops?.mark(
        args.id,
        intentionalStop,
        ptyIncarnationById.get(args.id) ?? null
      )
    : undefined
  let stopped = false
  try {
    await stopRendererOwnedPtyProcess(deps, args)
    stopped = true
  } finally {
    settleStop?.(stopped)
    if (!stopped) {
      // The failed shutdown left the process running.
      deps.runtime?.clearPtyStopRequest?.(args.id)
    }
  }
}

async function stopRendererOwnedPtyProcess(
  deps: PtyKillIpcDeps,
  args: { id: string; keepHistory?: boolean }
): Promise<void> {
  const { store, runtime, getLocalPtyProviderStartupPromise, shutdownProviderAndDetectExit } = deps
  runtime?.markPtyStopRequested?.(args.id)
  const connectionId = getPtySshConnectionId(args.id)
  const bridgedStop = stopLegacyRelayBridgedPty(args.id, connectionId, args.keepHistory === true)
  if (bridgedStop) {
    await bridgedStop
    return
  }
  // Why: wait for daemon startup before selecting the local provider, else a fallback shutdown falsely succeeds and orphans a restored daemon PTY (#7742).
  const startupPromise = getLocalPtyProviderStartupPromise(resolvePtyExecutionHost(args.id))
  if (startupPromise) {
    await startupPromise
  }
  const provider = tryGetProviderForPty(args.id)
  if (!provider && connectionId) {
    // Why: detached SSH PTYs intentionally keep ownership after their
    // provider is unregistered; hydrated app-scoped ids can also arrive
    // before ownership is rebuilt. Tombstone instead of falling back local.
    const unproven = PtyRetirementWithoutProof.because(SSH_PROVIDER_UNREGISTERED_REASON)
    const incarnationId = finishPtyShutdown(args.id, connectionId, store, unproven)
    publishSyntheticExit(deps, args.id, -1, incarnationId, unproven)
    return
  }
  const shutdownProvider = provider ?? getProviderForPty(args.id)
  const stoppingIncarnationId = ptyIncarnationById.get(args.id)
  let proof: PtyExitProof
  try {
    const providerExitObserved = await shutdownProviderAndDetectExit(shutdownProvider, args.id, {
      immediate: true,
      keepHistory: args.keepHistory ?? false
    })
    proof = PtyExitProof.from(
      providerExitObserved ? 'exit-observed' : 'shutdown-acknowledged',
      stoppingIncarnationId
    )
  } catch (err) {
    if (!isPtyAlreadyGoneError(err)) {
      // Why: a failed shutdown can leave the local daemon's process alive; keep ownership so a retry can reach it.
      throw err
    }
    proof = PtyExitProof.from('absent', stoppingIncarnationId)
  }
  // Why: some shutdown paths do not emit onExit through the provider listener.
  // Explicit cleanup is idempotent and covers already-dead PTYs.
  const incarnationId = finishPtyShutdown(args.id, connectionId, store, proof)
  if (proof.source !== 'exit-observed') {
    publishSyntheticExit(deps, args.id, -1, incarnationId, proof)
  }
}

async function stopFencedRendererPty(
  deps: PtyKillIpcDeps,
  args: PtyFencedTerminationRequest | undefined
): Promise<PtyFencedTerminationOutcome> {
  if (
    !args ||
    typeof args.id !== 'string' ||
    !args.id ||
    typeof args.expectedIncarnationId !== 'string' ||
    !args.expectedIncarnationId ||
    typeof args.requireNoAgentOwner !== 'boolean' ||
    typeof args.requireUnattached !== 'boolean' ||
    isRemoteRuntimePtyId(args.id) ||
    resolvePtyExecutionHost(args.id) !== LOCAL_EXECUTION_HOST_ID
  ) {
    return { outcome: 'refused', reason: 'unsupported' }
  }
  try {
    await deps.getLocalPtyProviderStartupPromise(LOCAL_EXECUTION_HOST_ID)
    const provider = tryGetProviderForPty(args.id)
    if (!provider?.killFenced) {
      return { outcome: 'refused', reason: 'unsupported' }
    }
    const result = await provider.killFenced(args)
    if (
      (result.outcome === 'ended' || result.outcome === 'already_exited') &&
      ptyIncarnationById.get(args.id) === args.expectedIncarnationId
    ) {
      deps.runtime?.markPtyStopRequested?.(args.id)
      finishPtyShutdown(
        args.id,
        null,
        deps.store,
        PtyExitProof.from(
          result.outcome === 'ended' ? 'shutdown-acknowledged' : 'absent',
          args.expectedIncarnationId
        )
      )
      deps.runtime?.onPtyExit(args.id, -1, args.expectedIncarnationId)
      deps.rememberSyntheticKillExit(args.id, args.expectedIncarnationId)
      deps.sendPtyExitToRenderer({
        id: args.id,
        code: -1,
        incarnationId: args.expectedIncarnationId
      })
    }
    return result
  } catch {
    return { outcome: 'refused', reason: 'unverifiable' }
  }
}
