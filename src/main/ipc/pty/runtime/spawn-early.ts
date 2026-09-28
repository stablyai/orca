import { parseAppWslPtyId } from '../../../../shared/wsl-pty-id'
import { prepareWslDaemonReattachHooks } from '../../../wsl/wsl-daemon-reattach-hooks'
import { isAgentStatusHooksEnabled } from '../../../agent-hooks/managed-agent-hook-controls'
import type { PtySpawnResult } from '../../../providers/types'
import { getAppPtyId } from '../provider/registry'
import { allocatePtyLifecycleSequence } from '../host-env/types'
import { snapshotCodexPaneHomeRoutes, codexReattachedHomeRouteField } from '../host-env/codex-home'
import { ensureWslHookRelayForReattach } from '../../../agent-hooks/wsl-hook-relay-reattach'
import type { CodexPaneHomeRoute } from '../../../codex/codex-pane-account-registry'
import type { RuntimePtySpawnState } from './spawn-state'

export function adoptMaterializedRuntimePtySpawn(
  ctx: RuntimePtySpawnState,
  startupAlreadyAwaited = false
): Promise<PtySpawnResult | null> | PtySpawnResult | null {
  const args = ctx.args
  // Why: the re-entry after the startup await must not re-mint the lifecycle
  // sequence or re-snapshot routes taken before the barrier.
  if (!startupAlreadyAwaited) {
    ctx.codexHomeLaunchStartedAt = !args.connectionId ? new Date() : undefined
    ctx.codexHomeLaunchStartedSequence = !args.connectionId
      ? allocatePtyLifecycleSequence()
      : undefined
    ctx.preAdoptedStablePane = args.adoptedStablePane ?? null
    ctx.reattachedCodexHomeRoutes = !args.connectionId
      ? new Map(
          snapshotCodexPaneHomeRoutes([
            ctx.preAdoptedStablePane?.result.id,
            args.sessionId ? getAppPtyId(args.connectionId, args.sessionId) : undefined
          ])
        )
      : new Map<string, CodexPaneHomeRoute | null>()
  }
  const startupPromise = ctx.deps.getLocalPtyStartupPromise(args.connectionId)
  if (startupPromise && !startupAlreadyAwaited) {
    return startupPromise.then(() => adoptMaterializedRuntimePtySpawn(ctx, true))
  }
  if (!ctx.preAdoptedStablePane?.materialized) {
    return null
  }
  const handle = ctx.preAdoptedStablePane.owner.handle ?? args.preAllocatedHandle
  if (!handle) {
    throw new Error('terminal_pane_owner_unknown')
  }
  ctx.result = {
    id: ctx.preAdoptedStablePane.result.id,
    ...(ctx.preAdoptedStablePane.result.incarnationId
      ? { incarnationId: ctx.preAdoptedStablePane.result.incarnationId }
      : {}),
    ...(typeof ctx.preAdoptedStablePane.result.wslDistro === 'string'
      ? { wslDistro: ctx.preAdoptedStablePane.result.wslDistro }
      : {}),
    stablePaneOwner: {
      handle,
      tabId: ctx.preAdoptedStablePane.owner.tabId,
      leafId: ctx.preAdoptedStablePane.owner.leafId
    }
  }
  ensureWslHookRelayForReattach(
    { id: ctx.result.id, isReattach: true, wslDistro: ctx.preAdoptedStablePane.result.wslDistro },
    args.connectionId
  )
  if (!args.connectionId) {
    ctx.deps.options?.onCodexHomePtySpawned?.({
      id: ctx.result.id,
      codexHomePath: null,
      reattached: true,
      startedAt: ctx.codexHomeLaunchStartedAt,
      startedSequence: ctx.codexHomeLaunchStartedSequence,
      ...codexReattachedHomeRouteField(ctx.reattachedCodexHomeRoutes, ctx.result.id, true)
    })
  }
  if (parseAppWslPtyId(ctx.result.id)) {
    return prepareWslDaemonReattachHooks({
      result: { ...ctx.result, isReattach: true },
      sessions: ctx.deps.options?.wslDaemonSessions,
      hooksEnabled: isAgentStatusHooksEnabled(ctx.deps.getSettings?.())
    }).then(() => ctx.result)
  }
  return ctx.result
}
