import {
  suppressSavedResumeLaunch,
  captureSavedResumeCleanup,
  chooseSavedResumeFreshLaunch,
  type ResumeSpawnAdmission,
  resumeSpawnRefusal,
  SavedResumeFreshRefusal
} from '../host-env/saved-resume-admission'
import type { AgentSessionClaimedSpawnResult } from '../../../../shared/agent-session-host-authority'
import type { PtySpawnResult } from '../../../providers/pty-provider-contract'
import { spawnWorktreeTarget } from '../../../../shared/worktree/host-qualified-identity'
import { ptyIncarnationById } from '../provider/ownership-state'
import { ensureWslHookRelayForReattach } from '../../../agent-hooks/wsl-hook-relay-reattach'
import { noteWslDistrosRunning } from '../../../wsl-background-distro-gate'
import {
  agentSessionOwners,
  assertSpawnReplyWasLive,
  reconcileAgentSessionOwnerListings
} from '../pane/agent-session-owners'
import { resolveStablePaneOwner } from '../pane/stable-owner'
import {
  assertPaneStillExists,
  excludeAbsentOwnerReplay,
  PaneOwnerContentionError
} from '../pane/pane-spawn-operation'
import { isRegisteredAgentSessionOwnerLive } from '../provider/liveness'
import { failPtySpawnExecute } from '../spawn-execute-failure'
import type { RuntimePtySpawnState } from './spawn-state'
import { markRuntimeSpawnHiddenBeforeSpawn } from './spawn-hidden-delivery'

export async function executeRuntimePtySpawn(ctx: RuntimePtySpawnState): Promise<void> {
  const args = ctx.args
  const captured: ResumeSpawnAdmission | null =
    args.launchAgent && args.resumeProviderSession
      ? {
          verdict: 'admitted',
          refused: { agent: args.launchAgent, providerSession: args.resumeProviderSession }
        }
      : null
  if (args.resumeOrigin === 'saved') {
    await captureSavedResumeCleanup(
      ctx.deps.runtime,
      ctx.deps.store,
      ctx.spawnIdentityPaneKey,
      captured,
      args.worktreeId
    )
  }
  const chooseFresh = async (): Promise<void> => {
    ctx.spawnOptions.env = { ...ctx.spawnOptions.env }
    ctx.resumeAdmission = await chooseSavedResumeFreshLaunch(
      ctx.deps.runtime,
      args,
      ctx.expectedWslDistro,
      ctx.spawnOptions
    )
    if (captured && ctx.resumeAdmission) {
      ctx.resumeAdmission.refused = captured.refused
      ctx.resumeAdmission.sourceRecord = captured.sourceRecord
    }
    if (resumeSpawnRefusal(ctx.resumeAdmission)) {
      ctx.launchCommand = undefined
      ctx.env = ctx.spawnOptions.env
    }
  }
  const runtime = ctx.deps.runtime
  const acquireWorktreeSpawn = runtime?.acquireWorktreeTerminalSpawn
  ctx.releaseWorktreeSpawn = acquireWorktreeSpawn
    ? await acquireWorktreeSpawn.call(
        runtime,
        spawnWorktreeTarget(args.worktreeId, args.connectionId),
        {
          refuseSleptWorktree: args.refuseSleptWorktree,
          // A pre-adopted stable pane attaches to its live owner, not a new terminal.
          reattachSessionId: ctx.preAdoptedStablePane?.owner.ptyId ?? args.sessionId,
          requireAttachOnly: () => {
            ctx.spawnOptions = { ...ctx.spawnOptions, attachOnly: true }
          }
        }
      )
    : undefined
  let awaitingAnotherStart = false
  try {
    if (args.preAllocatedHandle) {
      ctx.deps.trustedTerminalHandleEnv.add(args.preAllocatedHandle)
    }
    const stablePaneOwnerCandidate = ctx.preAdoptedStablePane
      ? ctx.preAdoptedStablePane.owner
      : args.agentSessionEnsure
        ? null
        : excludeAbsentOwnerReplay(
            resolveStablePaneOwner(
              ctx.deps.runtime,
              ctx.deps.store,
              ctx.spawnIdentityPaneKey,
              args.worktreeId,
              args.connectionId
            ),
            args.paneSpawnOperation?.absentOwner
          )
    if (stablePaneOwnerCandidate) {
      throw new PaneOwnerContentionError()
    }
    if (args.paneSpawnOperation?.mustExist && args.worktreeId && args.tabId && args.leafId) {
      assertPaneStillExists(
        ctx.deps.store,
        args.worktreeId,
        args.tabId,
        args.leafId,
        args.connectionId
      )
    }
    const expectedPtyId = ctx.effectiveSessionAppId ?? ctx.sessionId
    if (!stablePaneOwnerCandidate) {
      markRuntimeSpawnHiddenBeforeSpawn(ctx)
    }
    if (expectedPtyId) {
      ctx.pendingRegistrationClaim = ctx.deps.runtime?.beginPtyRegistration?.(expectedPtyId)
      ctx.pendingRegistrationPtyId = expectedPtyId
    }
    if (ctx.isDaemonHostSpawn && expectedPtyId) {
      ctx.preparedProvisionalExecutionContext =
        ctx.deps.runtime?.preparePtyExecutionContext?.(expectedPtyId, ctx.expectedWslDistro, {
          resetIncarnation: ctx.isNewDaemonSession && !stablePaneOwnerCandidate,
          preserveExisting: !ctx.isNewDaemonSession || Boolean(stablePaneOwnerCandidate)
        }) ?? false
    }
    const sequenceBeforeProviderSpawn = expectedPtyId
      ? (ctx.deps.runtime?.getPtyOutputSequence?.(expectedPtyId) ?? 0)
      : 0
    const assertClientStillConnected = (): void => {
      if (args.signal?.aborted) {
        throw new Error('client_disconnected')
      }
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
            assertClientStillConnected()
            await chooseFresh()
            const refusal = resumeSpawnRefusal(ctx.resumeAdmission)
            if (refusal) {
              throw new SavedResumeFreshRefusal(refusal)
            }
            providerResult = await ctx.provider.spawn(ctx.spawnOptions)
            ctx.rejectedRegistrationCandidate = providerResult
            // Why: a successful lower-owner return proves physical work committed even if admission sees an early exit.
            ctx.reportPtySpawnCommitted()
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
          isLive: isRegisteredAgentSessionOwnerLive,
          onJoin: () => {
            awaitingAnotherStart = true
          }
        })
      } catch (error) {
        if (!(error instanceof SavedResumeFreshRefusal)) {
          throw error
        }
        // The claim reservation rejected before spawn; this shell must never become its owner.
        ctx.resumeAdmission = {
          ...error.admission,
          refused: captured?.refused ?? error.admission.refused,
          sourceRecord: captured?.sourceRecord
        }
        suppressSavedResumeLaunch(args, ctx.spawnOptions)
        ctx.launchCommand = undefined
        ctx.env = ctx.spawnOptions.env
        delete args.agentSessionEnsure
        ctx.spawnOptions.agentSessionEnsure = undefined
        providerResult = await ctx.provider.spawn(ctx.spawnOptions)
        ctx.reportPtySpawnCommitted()
        ctx.stablePaneOwner = null
      }
      awaitingAnotherStart = false
      if (providerResult) {
        ctx.result = providerResult
      } else if (ensured) {
        ctx.result = {
          id: ensured.owner.ptyId,
          isReattach: true,
          // A listing's incarnation rejects delayed exits from an older process.
          incarnationId: ptyIncarnationById.get(ensured.owner.ptyId)
        }
      } else {
        throw new Error('agent_session_owner_missing')
      }
      if (ensured) {
        ctx.result.agentSessionEnsure = ensured
      }
    } else {
      assertClientStillConnected()
      await chooseFresh()
      ctx.result = await ctx.provider.spawn(ctx.spawnOptions)
      ctx.reportPtySpawnCommitted()
      ctx.stablePaneOwner = null
      ctx.rejectedRegistrationCandidate = ctx.result
    }
    if (ctx.result.isReattach || ctx.result.agentSessionEnsure?.disposition === 'adopted') {
      ctx.result.isReattach = true
      ctx.resumeAdmission = null
    }
    if (ctx.result.isReattach) {
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
      // Preserve the renderer-domain boundary needed to reconcile daemon snapshot kitty flags.
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
    ensureWslHookRelayForReattach(ctx.result)
    const spawnedWslDistro =
      ctx.result.wslDistro === undefined ? ctx.expectedWslDistro : ctx.result.wslDistro
    if (spawnedWslDistro && !args.connectionId) {
      // A local WSL terminal is user-initiated, so background work held for this distro may run.
      noteWslDistrosRunning([spawnedWslDistro])
    }
    ctx.deps.runtime?.preparePtyExecutionContext?.(ctx.result.id, spawnedWslDistro)
  } catch (err) {
    throw failPtySpawnExecute(ctx, err, {
      sessionId: ctx.sessionId,
      ownsNewSession: ctx.isNewDaemonSession,
      telemetry: args.telemetry,
      joinedAnotherStart: awaitingAnotherStart
    })
  } finally {
    if (args.preAllocatedHandle) {
      ctx.deps.trustedTerminalHandleEnv.delete(args.preAllocatedHandle)
    }
  }
}
