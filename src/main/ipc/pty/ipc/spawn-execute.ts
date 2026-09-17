import { ensureWslHookRelayForReattach } from '../../../agent-hooks/wsl-hook-relay-reattach'
import {
  SSH_SESSION_EXPIRED_ERROR,
  isSshPtyAbsentFromRelayError,
  isSshPtyIdentityMismatchError
} from '../../../providers/ssh-pty-errors'
import { classifyError } from '../../../telemetry/classify-error'
import { track } from '../../../telemetry/client'
import { getCohortAtEmit } from '../../../telemetry/cohort-classifier'
import { agentKindSchema } from '../../../../shared/telemetry-events'
import { isProviderAgentSessionOwnerLive, normalizeNodePtySpawnError } from '../provider/liveness'
import { resolveStablePaneOwner, spawnForStablePane } from '../pane/stable-owner'
import {
  agentSessionOwners,
  assertSpawnReplyWasLive,
  reconcileAgentSessionOwnerListings
} from '../pane/agent-session-owners'
import { deletePtyOwnership, ptyIncarnationById } from '../provider/ownership-state'
import { tryGetProviderForAgentSessionOwner } from '../provider/registry'
import { ptySizes } from '../delivery/visibility-state'
import { clearProviderPtyState } from '../provider/state-cleanup'
import { agentStatusExecutionBindingEnv } from '../../../../shared/agent-status-run'
import type { PtySpawnResult } from '../../../providers/types'
import type { PtyIpcSpawnState } from './spawn-state'

export async function executePtyIpcSpawn(ctx: PtyIpcSpawnState): Promise<void> {
  const args = ctx.args
  try {
    if (ctx.preAllocatedHandle) {
      ctx.deps.trustedTerminalHandleEnv.add(ctx.preAllocatedHandle)
    }
    ctx.spawnTiming.mark('options')
    const stablePaneOwnerCandidate = ctx.agentSessionEnsure
      ? null
      : resolveStablePaneOwner(
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
    if (ctx.agentSessionEnsure) {
      // Why: daemon-backed claims can outlive this controller; import all
      // proven owners before deciding that an identity is absent.
      await reconcileAgentSessionOwnerListings()
      const recoveredOwner = agentSessionOwners.find(ctx.agentSessionEnsure.claim)
      if (recoveredOwner && ctx.pendingRegistrationPtyId !== recoveredOwner.ptyId) {
        if (ctx.pendingRegistrationPtyId) {
          ctx.deps.runtime?.cancelPendingPtyRegistration?.(ctx.pendingRegistrationPtyId)
        }
        ctx.deps.runtime?.beginPtyRegistration?.(
          recoveredOwner.ptyId,
          ptyIncarnationById.get(recoveredOwner.ptyId)
        )
        ctx.pendingRegistrationPtyId = recoveredOwner.ptyId
      }
      let providerResult: PtySpawnResult | null = null
      const ensured = await agentSessionOwners.ensure({
        claim: ctx.agentSessionEnsure.claim,
        surface: ctx.agentSessionEnsure.surface,
        spawn: async ({ statusBinding }) => {
          providerResult = await ctx.provider.spawn({
            ...ctx.spawnOptions,
            env: {
              ...ctx.spawnOptions.env,
              ...agentStatusExecutionBindingEnv(statusBinding)
            }
          })
          ctx.rejectedRegistrationCandidate = providerResult
          assertSpawnReplyWasLive(providerResult)
          ctx.deps.runtime?.assertPtyRegistrationAllowed?.(
            providerResult.id,
            providerResult.incarnationId
          )
          if (providerResult.incarnationId) {
            // Why: local providers cannot serialize controller claims, so liveness proof
            // needs the exact incarnation before the registry promotes the new owner.
            ptyIncarnationById.set(providerResult.id, providerResult.incarnationId)
          }
          const providerEnsure = providerResult.agentSessionEnsure
          return {
            ptyId: providerResult.id,
            ...(providerEnsure
              ? {
                  owner: providerEnsure.owner,
                  disposition: providerEnsure.disposition
                }
              : {})
          }
        },
        isLive: async (owner) => {
          const ownerProvider = tryGetProviderForAgentSessionOwner(owner.ptyId)
          if (!ownerProvider) {
            // Why: a disconnected relay may keep its PTY alive during the
            // grace window; missing transport is unknown, never absence.
            throw new Error('execution_owner_unavailable')
          }
          return await isProviderAgentSessionOwnerLive(ownerProvider, owner)
        }
      })
      ctx.result = providerResult ?? {
        id: ensured.owner.ptyId,
        isReattach: true,
        // Why: adoption from an authoritative listing must preserve the
        // incarnation proof used to reject a delayed exit from an older process.
        incarnationId: ptyIncarnationById.get(ensured.owner.ptyId)
      }
      ctx.result.agentSessionEnsure = ensured
      ctx.stablePaneOwner = null
    } else {
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
      assertSpawnReplyWasLive(ctx.result)
    }
    ctx.rejectedRegistrationCandidate ??= ctx.result
    if (ctx.pendingRegistrationPtyId !== ctx.result.id) {
      if (ctx.pendingRegistrationPtyId) {
        ctx.deps.runtime?.cancelPendingPtyRegistration?.(ctx.pendingRegistrationPtyId)
      }
      ctx.deps.runtime?.beginPtyRegistration?.(ctx.result.id, ctx.result.incarnationId)
      ctx.pendingRegistrationPtyId = ctx.result.id
    }
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
    // The message alone cannot carry this decision. All three reattach refusals are minted with the
    // same `SSH_SESSION_EXPIRED` text, and only one of them observed the process: `restoreRequired`
    // means the PTY is LIVE and only its source stream needs rebuilding, which
    // `ssh-pty-errors.ts` states outright. Expiring its lease and deleting its ownership erases
    // this client's last record of a running remote process, and #9819's sweep reads a PTY it has
    // no record of as one it may SIGKILL on the next connect. Only positive host-reported absence
    // may reach that bookkeeping; being too strict here merely leaves a dead lease for the next
    // reattach to retire on real host evidence.
    const relayReportedSessionAbsent = isExpiredSshSession && isSshPtyAbsentFromRelayError(err)
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
    if (
      args.connectionId &&
      ctx.effectiveSessionRelayId !== undefined &&
      relayReportedSessionAbsent
    ) {
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
