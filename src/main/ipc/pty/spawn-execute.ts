import type { PtySpawnResult } from '../../providers/pty-provider-contract'
import { ptyIncarnationById } from './provider/ownership-state'
import { ensureWslHookRelayForReattach } from '../../agent-hooks/wsl-hook-relay-reattach'
import { noteWslDistrosRunning } from '../../wsl-background-distro-gate'
import {
  agentSessionOwners,
  assertSpawnReplyWasLive,
  reconcileAgentSessionOwnerListings
} from './pane/agent-session-owners'
import { resolveStablePaneOwner } from './pane/stable-owner'
import {
  assertPaneStillExists,
  excludeAbsentOwnerReplay,
  PaneOwnerContentionError
} from './pane/pane-spawn-operation'
import { isRegisteredAgentSessionOwnerLive } from './provider/liveness'
import type { AgentSessionClaimedSpawnResult } from '../../../shared/agent-session-host-authority'
import {
  resumeSpawnRefusal,
  SavedResumeFreshRefusal,
  suppressSavedResumeLaunch,
  type ResumeSpawnRefusal
} from './host-env/saved-resume-admission'
import { failPtySpawnExecute } from './spawn-execute-failure'
import type { PtySpawnOperationState, PtySpawnExecutionFacts } from './spawn-operation-state'
import { excludeReplacedPaneOwner } from './pane/replaced-pane-owner'
import { attachViewWithoutOwner } from './pane/attach-only-view'

export async function executePtySpawn(
  ctx: PtySpawnOperationState,
  facts: PtySpawnExecutionFacts,
  chooseFresh: (inherited?: ResumeSpawnRefusal) => Promise<void>
): Promise<void> {
  const args = ctx.args
  let awaitingAnotherStart = false
  try {
    if (facts.preAllocatedHandle) {
      ctx.deps.trustedTerminalHandleEnv.add(facts.preAllocatedHandle)
    }
    const stablePaneOwnerCandidate = ctx.preAdoptedStablePane
      ? ctx.preAdoptedStablePane.owner
      : args.agentSessionEnsure
        ? null
        : excludeAbsentOwnerReplay(
            excludeReplacedPaneOwner(
              resolveStablePaneOwner(
                ctx.deps.runtime,
                ctx.deps.store,
                facts.paneKey,
                args.worktreeId,
                args.connectionId
              ),
              facts.replacedPaneOwner ?? null
            ),
            ctx.paneSpawnOperation?.absentOwner
          )
    if (stablePaneOwnerCandidate) {
      throw new PaneOwnerContentionError()
    }
    const expectedPtyId = ctx.effectiveSessionAppId ?? facts.sessionId
    if (expectedPtyId) {
      ctx.pendingRegistrationClaim = ctx.deps.runtime?.beginPtyRegistration?.(expectedPtyId)
      ctx.pendingRegistrationPtyId = expectedPtyId
    }
    if (ctx.isDaemonHostSpawn && expectedPtyId) {
      ctx.preparedProvisionalExecutionContext =
        ctx.deps.runtime?.preparePtyExecutionContext?.(expectedPtyId, ctx.expectedWslDistro, {
          resetIncarnation: ctx.ownsNewIncarnation && !stablePaneOwnerCandidate,
          preserveExisting: !ctx.ownsNewIncarnation || Boolean(stablePaneOwnerCandidate)
        }) ?? false
    }
    const sequenceBeforeProviderSpawn = expectedPtyId
      ? (ctx.deps.runtime?.getPtyOutputSequence?.(expectedPtyId) ?? 0)
      : 0
    ctx.spawnTiming?.mark('options')
    const validateDispatch = (): void => {
      facts.validateDispatch?.()
      if (ctx.paneSpawnOperation?.mustExist && args.worktreeId && args.tabId && args.leafId) {
        assertPaneStillExists(
          ctx.deps.store,
          args.worktreeId,
          args.tabId,
          args.leafId,
          args.connectionId
        )
      }

      if (args.signal?.aborted) {
        throw new Error('client_disconnected')
      }
      facts.beforeProviderSpawn?.()
    }
    if (args.agentSessionEnsure && !ctx.preAdoptedStablePane) {
      // Claims can outlive this controller; import authoritative owner listings before deciding absence.
      await reconcileAgentSessionOwnerListings()
      const recoveredOwner = agentSessionOwners.find(args.agentSessionEnsure.claim)
      if (recoveredOwner && ctx.pendingRegistrationPtyId !== recoveredOwner.ptyId) {
        if (ctx.pendingRegistrationPtyId) {
          ctx.deps.runtime?.cancelPendingPtyRegistration?.(
            ctx.pendingRegistrationPtyId,
            undefined,
            ctx.pendingRegistrationClaim
          )
        }
        ctx.pendingRegistrationClaim = ctx.deps.runtime?.beginPtyRegistration?.(
          recoveredOwner.ptyId,
          ptyIncarnationById.get(recoveredOwner.ptyId)
        )
        ctx.pendingRegistrationPtyId = recoveredOwner.ptyId
      }
      let providerResult: PtySpawnResult | null = null
      let ensured: AgentSessionClaimedSpawnResult | undefined
      try {
        ensured = await agentSessionOwners.ensure({
          claim: args.agentSessionEnsure.claim,
          surface: args.agentSessionEnsure.surface,
          spawn: async () => {
            await chooseFresh()
            const refusal = resumeSpawnRefusal(ctx.resumeAdmission)
            if (refusal) {
              throw new SavedResumeFreshRefusal(refusal)
            }
            validateDispatch()
            providerResult = await ctx.provider.spawn(ctx.spawnOptions)
            ctx.rejectedRegistrationCandidate = providerResult
            // Lower-owner success proves physical commit even when registration observes an early exit.
            facts.reportPtySpawnCommitted?.()
            assertSpawnReplyWasLive(providerResult)
            ctx.deps.runtime?.assertPtyRegistrationAllowed?.(
              providerResult.id,
              providerResult.incarnationId
            )
            if (providerResult.incarnationId) {
              // In-process providers cannot list controller claims; record exact incarnation before ownership promotion.
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
          isLive: isRegisteredAgentSessionOwnerLive,
          onJoin: () => {
            awaitingAnotherStart = true
          }
        })
      } catch (error) {
        if (!(error instanceof SavedResumeFreshRefusal)) {
          throw error
        }
        // The claim has unwound; the refused shell must never become its agent owner.
        await chooseFresh(error.admission)
        suppressSavedResumeLaunch(args, ctx.spawnOptions)
        facts.suppressRefusedLaunch?.()
        delete args.agentSessionEnsure
        delete ctx.spawnOptions.agentSessionEnsure
        validateDispatch()
        providerResult = await ctx.provider.spawn(ctx.spawnOptions)
        facts.reportPtySpawnCommitted?.()
        ctx.stablePaneOwner = null
      }
      awaitingAnotherStart = false
      if (providerResult) {
        ctx.result = providerResult
      } else if (ensured) {
        ctx.result = {
          id: ensured.owner.ptyId,
          isReattach: true,
          incarnationId: ptyIncarnationById.get(ensured.owner.ptyId)
        }
      } else {
        throw new Error('agent_session_owner_missing')
      }
      if (ensured) {
        ctx.result.agentSessionEnsure = ensured
      }
    } else {
      if (!facts.attachOnlyView) {
        await chooseFresh()
      }
      validateDispatch()
      ctx.result = facts.attachOnlyView
        ? await attachViewWithoutOwner(ctx.provider, ctx.spawnOptions)
        : await ctx.provider.spawn(ctx.spawnOptions)
      facts.reportPtySpawnCommitted?.()
      ctx.stablePaneOwner = null
      ctx.rejectedRegistrationCandidate = ctx.result
    }
    if (ctx.result.isReattach || ctx.result.agentSessionEnsure?.disposition === 'adopted') {
      ctx.result.isReattach = true
      ctx.resumeAdmission = null
      Object.assign(ctx.result, ctx.deps.runtime?.getTerminalLaunchResult?.(ctx.result.id))
    }
    ctx.rejectedRegistrationCandidate ??= ctx.result
    if (ctx.pendingRegistrationPtyId !== ctx.result.id) {
      if (ctx.pendingRegistrationPtyId) {
        ctx.deps.runtime?.cancelPendingPtyRegistration?.(
          ctx.pendingRegistrationPtyId,
          undefined,
          ctx.pendingRegistrationClaim
        )
      }
      ctx.pendingRegistrationClaim = ctx.deps.runtime?.beginPtyRegistration?.(
        ctx.result.id,
        ctx.result.incarnationId
      )
      ctx.pendingRegistrationPtyId = ctx.result.id
    }
    assertSpawnReplyWasLive(ctx.result)
    // Admit registration before mutating sequence/context or publishing durable state.
    if (
      ctx.pendingRegistrationClaim &&
      !ctx.deps.runtime?.narrowPtyRegistration(
        ctx.result.id,
        ctx.pendingRegistrationClaim,
        ctx.result.incarnationId
      )
    ) {
      throw new PaneOwnerContentionError()
    }
    ctx.deps.runtime?.assertPtyRegistrationAllowed?.(ctx.result.id, ctx.result.incarnationId)
    if (ctx.result.providerSequence) {
      const runtimeSequenceBeforeReconcile =
        ctx.deps.runtime?.getPtyOutputSequence?.(ctx.result.id) ?? 0
      // Keyboard flags require the snapshot boundary translated into the renderer sequence domain.
      const translatedSnapshotSeq =
        ctx.deps.runtime?.synchronizePtyOutputSequenceFromProvider?.(
          ctx.result.id,
          ctx.result.providerSequence,
          sequenceBeforeProviderSpawn
        ) ?? null
      ctx.provedSnapshotSeq =
        runtimeSequenceBeforeReconcile <= sequenceBeforeProviderSpawn &&
        typeof ctx.result.snapshotKittyKeyboardFlags === 'number'
          ? (translatedSnapshotSeq ?? undefined)
          : undefined
    }
    ensureWslHookRelayForReattach(ctx.result)
    const spawnedWslDistro =
      ctx.result.wslDistro === undefined ? ctx.expectedWslDistro : ctx.result.wslDistro
    if (spawnedWslDistro && !args.connectionId) {
      // A local WSL terminal is user-initiated, so background work held for this distro may run.
      noteWslDistrosRunning([spawnedWslDistro])
    }
    ctx.deps.runtime?.preparePtyExecutionContext?.(ctx.result.id, spawnedWslDistro)
    ctx.spawnTiming?.mark('provider_spawn')
  } catch (err) {
    throw failPtySpawnExecute(ctx, err, {
      sessionId: facts.sessionId,
      ownsNewSession: ctx.ownsNewIncarnation,
      telemetry: args.telemetry,
      joinedAnotherStart: awaitingAnotherStart
    })
  } finally {
    if (facts.preAllocatedHandle) {
      ctx.deps.trustedTerminalHandleEnv.delete(facts.preAllocatedHandle)
    }
  }
}
