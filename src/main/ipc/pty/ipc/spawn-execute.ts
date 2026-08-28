import { ensureWslHookRelayForReattach } from '../../../agent-hooks/wsl-hook-relay-reattach'
import {
  SSH_SESSION_EXPIRED_ERROR,
  isSshPtyIdentityMismatchError
} from '../../../providers/ssh-pty-errors'
import { classifyError } from '../../../telemetry/classify-error'
import { track } from '../../../telemetry/client'
import { getCohortAtEmit } from '../../../telemetry/cohort-classifier'
import { agentKindSchema } from '../../../../shared/telemetry-events'
import { normalizeNodePtySpawnError } from '../provider/liveness'
import { resolveStablePaneOwner, spawnForStablePane } from '../pane/stable-owner'
import { assertSpawnReplyWasLive } from '../pane/agent-session-owners'
import { deletePtyOwnership } from '../provider/ownership-state'
import { ptySizes } from '../delivery/visibility-state'
import { clearProviderPtyState } from '../provider/state-cleanup'
import type { PtyIpcSpawnState } from './spawn-state'

export async function executePtyIpcSpawn(ctx: PtyIpcSpawnState): Promise<void> {
  const args = ctx.args
  try {
    if (ctx.preAllocatedHandle) {
      ctx.deps.trustedTerminalHandleEnv.add(ctx.preAllocatedHandle)
    }
    ctx.spawnTiming.mark('options')
    const stablePaneOwnerCandidate = resolveStablePaneOwner(
      ctx.deps.runtime,
      ctx.deps.store,
      ctx.reservationPaneKey,
      args.worktreeId,
      args.connectionId
    )
    const expectedPtyId =
      stablePaneOwnerCandidate?.ptyId ?? ctx.effectiveSessionAppId ?? ctx.effectiveSessionId
    if (expectedPtyId) {
      ctx.deps.runtime?.beginPtyRegistration?.(expectedPtyId)
      ctx.pendingRegistrationPtyId = expectedPtyId
    }
    if (ctx.isDaemonHostSpawn && expectedPtyId) {
      ctx.preparedProvisionalExecutionContext =
        ctx.deps.runtime?.preparePtyExecutionContext?.(expectedPtyId, ctx.expectedWslDistro, {
          resetIncarnation: ctx.isMintedSessionId && !stablePaneOwnerCandidate,
          preserveExisting: !ctx.isMintedSessionId || Boolean(stablePaneOwnerCandidate)
        }) ?? false
    }
    const sequenceBeforeProviderSpawn = expectedPtyId
      ? (ctx.deps.runtime?.getPtyOutputSequence?.(expectedPtyId) ?? 0)
      : 0
    const stablePaneSpawn = ctx.preAdoptedStablePane
      ? ctx.preAdoptedStablePane
      : await spawnForStablePane({
          runtime: ctx.deps.runtime,
          store: ctx.deps.store,
          provider: ctx.provider,
          spawnOptions: ctx.spawnOptions,
          owner: stablePaneOwnerCandidate,
          worktreeId: args.worktreeId,
          connectionId: args.connectionId,
          resolveOwner: () =>
            resolveStablePaneOwner(
              ctx.deps.runtime,
              ctx.deps.store,
              ctx.reservationPaneKey,
              args.worktreeId,
              args.connectionId
            )
        })
    ctx.result = stablePaneSpawn.result
    ctx.stablePaneOwner = stablePaneSpawn.owner
    if (
      ctx.stablePaneOwner &&
      ctx.isMintedSessionId &&
      ctx.effectiveSessionAppId &&
      ctx.effectiveSessionAppId !== ctx.result.id
    ) {
      clearProviderPtyState(ctx.effectiveSessionAppId)
    }
    ctx.rejectedRegistrationCandidate = ctx.result
    if (ctx.pendingRegistrationPtyId !== ctx.result.id) {
      if (ctx.pendingRegistrationPtyId) {
        ctx.deps.runtime?.cancelPendingPtyRegistration?.(ctx.pendingRegistrationPtyId)
      }
      ctx.deps.runtime?.beginPtyRegistration?.(ctx.result.id, ctx.result.incarnationId)
      ctx.pendingRegistrationPtyId = ctx.result.id
    }
    assertSpawnReplyWasLive(ctx.result)
    ctx.deps.runtime?.assertPtyRegistrationAllowed?.(ctx.result.id, ctx.result.incarnationId)
    if (ctx.result.providerSequence) {
      const runtimeSequenceBeforeReconcile =
        ctx.deps.runtime?.getPtyOutputSequence?.(ctx.result.id) ?? 0
      // Why kept: this is the reattach boundary in the RENDERER's sequence
      // domain, and the daemon snapshot's kitty flags mean nothing without
      // the boundary they were proven at.
      ctx.reconciledSnapshotSeq =
        ctx.deps.runtime?.synchronizePtyOutputSequenceFromProvider?.(
          ctx.result.id,
          ctx.result.providerSequence,
          sequenceBeforeProviderSpawn
        ) ?? null
      if (runtimeSequenceBeforeReconcile > sequenceBeforeProviderSpawn) {
        ctx.snapshotKittyFlagsCoverReconciledSeq = false
      }
    }
    ensureWslHookRelayForReattach(ctx.result, args.connectionId)
    ctx.deps.runtime?.preparePtyExecutionContext?.(
      ctx.result.id,
      args.connectionId
        ? null
        : ctx.result.wslDistro === undefined
          ? ctx.expectedWslDistro
          : ctx.result.wslDistro
    )
    ctx.spawnTiming.mark('provider_spawn')
  } catch (err) {
    if (
      (ctx.isMintedSessionId || ctx.preparedProvisionalExecutionContext) &&
      ctx.effectiveSessionAppId
    ) {
      ctx.deps.runtime?.preparePtyExecutionContext?.(ctx.effectiveSessionAppId, null, {
        resetIncarnation: true
      })
    }
    // Why: a stale hidden mark on this session id would gate a later visible attach that reuses it.
    if (ctx.preSpawnHiddenMarkId !== null) {
      ctx.deps.transitionSpawnHiddenRendererPtyDeliveryState(ctx.preSpawnHiddenMarkId, false)
    }
    const rawMessage = err instanceof Error ? err.message : String(err)
    if (rawMessage === 'agent_session_exited_during_start' && ctx.rejectedRegistrationCandidate) {
      ctx.deps.runtime?.releaseRejectedPtyRegistrationFence?.(
        ctx.rejectedRegistrationCandidate.id,
        ctx.rejectedRegistrationCandidate.incarnationId
      )
    }
    if (ctx.pendingRegistrationPtyId) {
      ctx.deps.runtime?.cancelPendingPtyRegistration?.(
        ctx.pendingRegistrationPtyId,
        ctx.rejectedRegistrationCandidate?.incarnationId
      )
      ctx.pendingRegistrationPtyId = null
    }
    const spawnError = normalizeNodePtySpawnError(err)
    const isIdentityMismatch =
      isSshPtyIdentityMismatchError(spawnError) || isSshPtyIdentityMismatchError(rawMessage)
    const isExpiredSshSession =
      Boolean(args.connectionId) &&
      (spawnError.message.includes(SSH_SESSION_EXPIRED_ERROR) ||
        rawMessage.includes(SSH_SESSION_EXPIRED_ERROR))
    const exitedBeforeSpawnReply =
      ctx.rejectedRegistrationCandidate?.exitedBeforeSpawnReply === true
    if (ctx.effectiveSessionAppId !== undefined) {
      if (
        ctx.hadSessionSizeBeforeAttach &&
        ctx.sessionSizeBeforeAttach &&
        (isIdentityMismatch || (!isExpiredSshSession && !exitedBeforeSpawnReply))
      ) {
        ptySizes.set(ctx.effectiveSessionAppId, ctx.sessionSizeBeforeAttach)
      } else {
        ptySizes.delete(ctx.effectiveSessionAppId)
      }
    }
    if (args.connectionId && ctx.effectiveSessionRelayId !== undefined && isExpiredSshSession) {
      // Why: expired remote reattach = relay already dropped the PTY; clear the lease so writes can't restore the stale binding.
      if (ctx.effectiveSessionAppId !== undefined && !isIdentityMismatch) {
        clearProviderPtyState(ctx.effectiveSessionAppId)
        deletePtyOwnership(ctx.effectiveSessionAppId)
      }
      if (!isIdentityMismatch) {
        ctx.deps.store?.markSshRemotePtyLease(
          args.connectionId,
          ctx.effectiveSessionRelayId,
          'expired'
        )
      }
    }
    // Why: provider state buildPtyHostEnv materialized for this minted id leaks if spawn failed.
    if (ctx.isMintedSessionId && ctx.effectiveSessionId !== undefined) {
      clearProviderPtyState(ctx.effectiveSessionId)
    }
    // Why: telemetry-plan.md§agent_error — attribute the error to the renderer-threaded agent_kind, else sniff the command for `claude`; raw messages are dropped at the validator boundary.
    const rendererAgentKindParse =
      args.telemetry?.agent_kind !== undefined
        ? agentKindSchema.safeParse(args.telemetry.agent_kind)
        : null
    const errorAgentKind = rendererAgentKindParse?.success
      ? rendererAgentKindParse.data
      : ctx.isClaudeLaunch
        ? ('claude-code' as const)
        : null
    if (errorAgentKind) {
      const classified = classifyError(spawnError)
      track('agent_error', {
        agent_kind: errorAgentKind,
        error_class: classified.error_class,
        ...getCohortAtEmit()
      })
    }
    throw spawnError
  } finally {
    if (ctx.preAllocatedHandle) {
      ctx.deps.trustedTerminalHandleEnv.delete(ctx.preAllocatedHandle)
    }
  }
}
