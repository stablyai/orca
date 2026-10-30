import type { PtySpawnOperationState } from './spawn-operation-state'
import type { AdoptStablePaneResult } from './ipc/spawn-types'
import { resolveEarlyPaneKey, resolveEarlyPaneSpawnReservationKey } from './spawn-pane-coordinates'
import { consumeExitedPaneOperation } from './pane/adopt-stable'
import { codexReattachedHomeRouteField, snapshotCodexPaneHomeRoutes } from './host-env/codex-home'
import { allocatePtyLifecycleSequence } from './host-env/types'
import { resolveStablePaneOwner } from './pane/stable-owner'
import { getAppPtyId } from './provider/registry'
import { ptyOwnership, ptyIncarnationById } from './provider/ownership-state'
import { attachOnlyViewOf } from './pane/attach-only-view'
import { pendingRuntimePaneCreatesByOwnerKey } from './pane/spawn-reservation'
import { getConnectionExecutionHostId } from '../../../shared/execution-host'
import { ensureWslHookRelayForReattach } from '../../agent-hooks/wsl-hook-relay-reattach'

export async function beginPtySpawn(
  ctx: PtySpawnOperationState,
  renderer?: boolean
): Promise<AdoptStablePaneResult | null> {
  const args = ctx.args
  // Capture lifecycle and home routes once, before startup can yield.
  ctx.codexHomeLaunchStartedAt = !args.connectionId ? new Date() : undefined
  ctx.codexHomeLaunchStartedSequence = !args.connectionId
    ? allocatePtyLifecycleSequence()
    : undefined
  const paneKey = resolveEarlyPaneKey(args)
  const owner = resolveStablePaneOwner(
    ctx.deps.runtime,
    ctx.deps.store,
    paneKey,
    args.worktreeId,
    args.connectionId
  )
  ctx.reattachedCodexHomeRoutes = !args.connectionId
    ? new Map(
        snapshotCodexPaneHomeRoutes([
          ctx.preAdoptedStablePane?.result.id,
          owner?.ptyId,
          args.sessionId ? getAppPtyId(args.connectionId, args.sessionId) : undefined
        ])
      )
    : new Map()
  const startup = ctx.deps.getLocalPtyStartupPromise(
    getConnectionExecutionHostId(args.connectionId)
  )
  if (startup) {
    await startup
  }
  ctx.cwd = ctx.deps.resolvePtySpawnStartupCwd(args.worktreeId, args.cwd)
  // Inherited producers and replacements already own this acquisition and must never await themselves.
  if (
    ctx.paneSpawnOperation ||
    ctx.paneSpawnReservation ||
    ctx.preAdoptedStablePane?.materialized
  ) {
    return null
  }
  const key = resolveEarlyPaneSpawnReservationKey(args)
  const pending = key ? pendingRuntimePaneCreatesByOwnerKey.get(key) : undefined
  if (!pending) {
    return null
  }
  const created = await pending.promise
  if (
    pending.operation?.acquisition?.reservation.outcome?.kind === 'registration-exited' &&
    args.tabId &&
    args.leafId
  ) {
    return consumeExitedPaneOperation(
      ctx.deps.runtime,
      ctx.deps.store,
      { ...args, tabId: args.tabId, leafId: args.leafId, renderer },
      pending.operation
    )
  }
  if (
    attachOnlyViewOf(args) &&
    created &&
    created.id === args.sessionId &&
    (created.coldRestore || typeof created.snapshot === 'string') &&
    ptyOwnership.has(created.id) &&
    (created.incarnationId === undefined ||
      ptyIncarnationById.get(created.id) === created.incarnationId)
  ) {
    return {
      result: created,
      owner: { ptyId: created.id, tabId: args.tabId!, leafId: args.leafId! },
      materialized: true
    }
  }
  return null
}

export function reportPtyPaneAdoption(
  ctx: PtySpawnOperationState,
  adopted: AdoptStablePaneResult
): void {
  if (adopted.outcome?.kind === 'registration-exited') {
    return
  }
  ensureWslHookRelayForReattach(adopted.result, ctx.args.connectionId)
  ctx.deps.options?.onCodexHomePtySpawned?.({
    id: adopted.result.id,
    codexHomePath: null,
    reattached: true,
    startedAt: ctx.codexHomeLaunchStartedAt,
    startedSequence: ctx.codexHomeLaunchStartedSequence,
    ...codexReattachedHomeRouteField(ctx.reattachedCodexHomeRoutes, adopted.result.id, true)
  })
}
