import type { PtySpawnResult } from '../../../providers/pty-provider-contract'
import { spawnWorktreeTarget } from '../../../../shared/worktree/host-qualified-identity'
import { ptyIncarnationById } from '../provider/ownership-state'
import { tryGetProviderForPty } from '../provider/registry'
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
import { isProviderAgentSessionOwnerLive } from '../provider/liveness'
import { failPtySpawnExecute } from '../spawn-execute-failure'
import type { RuntimePtySpawnState } from './spawn-state'
import { markRuntimeSpawnHiddenBeforeSpawn } from './spawn-hidden-delivery'

export async function executeRuntimePtySpawn(ctx: RuntimePtySpawnState): Promise<void> {
  const args = ctx.args
  const runtime = ctx.deps.runtime
  const acquireWorktreeSpawn = runtime?.acquireWorktreeTerminalSpawn
  ctx.releaseWorktreeSpawn = acquireWorktreeSpawn
    ? await acquireWorktreeSpawn.call(
        runtime,
        spawnWorktreeTarget(args.worktreeId, args.connectionId),
        { refuseSleptWorktree: args.refuseSleptWorktree }
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
      // Why: daemon-backed claims can outlive this controller; import all
      // proven owners before deciding that an identity is absent.
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
      const ensured = await agentSessionOwners.ensure({
        claim: args.agentSessionEnsure.claim,
        surface: args.agentSessionEnsure.surface,
        spawn: async () => {
          assertClientStillConnected()
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
        isLive: async (owner) => {
          const ownerProvider = tryGetProviderForPty(owner.ptyId)
          if (!ownerProvider) {
            // Why: an owner on a host this process cannot reach is unknown, never absent.
            throw new Error('execution_owner_unavailable')
          }
          return await isProviderAgentSessionOwnerLive(ownerProvider, owner)
        },
        onJoin: () => {
          awaitingAnotherStart = true
        }
      })
      awaitingAnotherStart = false
      ctx.result = providerResult ?? {
        id: ensured.owner.ptyId,
        isReattach: true,
        // Why: adoption from an authoritative listing must preserve the
        // incarnation proof used to reject a delayed exit from an older process.
        incarnationId: ptyIncarnationById.get(ensured.owner.ptyId)
      }
      ctx.result.agentSessionEnsure = ensured
    } else {
      assertClientStillConnected()
      ctx.result = await ctx.provider.spawn(ctx.spawnOptions)
      ctx.reportPtySpawnCommitted()
      ctx.stablePaneOwner = null
      ctx.rejectedRegistrationCandidate = ctx.result
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
    // Why: admission precedes sequence/context state and every durable publication below.
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
