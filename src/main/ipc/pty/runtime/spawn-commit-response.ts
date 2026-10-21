import { startupCwdFallbackOutcome } from '../spawn-startup-target'
import type { RuntimePtySpawnState } from './spawn-state'
import { resolvePaneSpawnReservation } from '../pane/spawn-reservation'

export function completeRuntimeSpawnResponse(ctx: RuntimePtySpawnState) {
  const args = ctx.args
  const startupCwdFallback = startupCwdFallbackOutcome(ctx.startupCwdFallback, ctx.result)
  const savedStartupCwd =
    (startupCwdFallback ? ctx.correctStartupCwd : undefined) ?? ctx.requestedCwd
  const response = {
    savedStartupCwd,
    id: ctx.result.id,
    ...(ctx.result.incarnationId ? { incarnationId: ctx.result.incarnationId } : {}),
    ...(ctx.stablePaneOwner && (ctx.stablePaneOwner.handle || args.preAllocatedHandle)
      ? {
          stablePaneOwner: {
            handle: ctx.stablePaneOwner.handle ?? args.preAllocatedHandle!,
            tabId: ctx.stablePaneOwner.tabId,
            leafId: ctx.stablePaneOwner.leafId
          }
        }
      : {}),
    ...(ctx.result.agentSessionEnsure ? { agentSessionEnsure: ctx.result.agentSessionEnsure } : {}),
    ...(startupCwdFallback ? { startupCwdFallback } : {})
  }
  resolvePaneSpawnReservation(ctx.paneSpawnReservationKey, ctx.paneSpawnReservation, {
    ...ctx.result,
    ...(typeof ctx.result.snapshotKittyKeyboardFlags === 'number' &&
    ctx.reconciledSnapshotSeq !== null &&
    ctx.snapshotKittyFlagsCoverReconciledSeq
      ? { snapshotSeq: ctx.reconciledSnapshotSeq }
      : { snapshotKittyKeyboardFlags: undefined }),
    isReattach: true
  })
  return { ...ctx.result, ...response, wslDistro: ctx.result.wslDistro ?? undefined }
}
