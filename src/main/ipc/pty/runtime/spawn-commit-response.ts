import type { StartupCwdFallback } from '../../../../shared/startup-cwd-fallback'
import type { RuntimePtySpawnState } from './spawn-state'

/** Joiners get the provider result at its proven kitty boundary as an attach; the caller gets the
 *  saved folder and host fields too. */
export function runtimeSpawnJoinPayload(
  ctx: RuntimePtySpawnState,
  startupCwdFallback: StartupCwdFallback | undefined,
  correctStartupCwd: string | undefined
) {
  const args = ctx.args
  const savedStartupCwd = correctStartupCwd ?? ctx.requestedCwd
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
  return {
    reservation: {
      ...ctx.result,
      ...(typeof ctx.result.snapshotKittyKeyboardFlags === 'number' &&
      ctx.reconciledSnapshotSeq !== null &&
      ctx.snapshotKittyFlagsCoverReconciledSeq
        ? { snapshotSeq: ctx.reconciledSnapshotSeq }
        : { snapshotKittyKeyboardFlags: undefined }),
      isReattach: true
    },
    reply: { ...ctx.result, ...response, wslDistro: ctx.result.wslDistro ?? undefined }
  }
}
