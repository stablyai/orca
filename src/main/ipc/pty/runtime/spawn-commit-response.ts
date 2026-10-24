import type { StartupCwdFallback } from '../../../../shared/startup-cwd-fallback'
import type { RuntimePtySpawnState } from './spawn-state'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import type { PaneResumeOutcome } from '../../../../shared/workspace-layout/workspace-layout-published'

type RuntimeResumeOutcomeState = Pick<
  RuntimePtySpawnState,
  'args' | 'result' | 'codexResumeArgvDropped'
> & { codexResumeUnavailable?: boolean }

/** Whether a fresh start resumed the agent it was asked to; a reattach ran no launch command. */
export function resumeOutcomeOf(ctx: RuntimeResumeOutcomeState): PaneResumeOutcome | null {
  if (!ctx.args.resumeProviderSession || ctx.result.isReattach) {
    return null
  }
  if (ctx.codexResumeUnavailable) {
    return 'resume-unavailable'
  }
  // A resume dropped silently named another agent's session: nothing came back, and nothing is owed.
  return ctx.codexResumeArgvDropped ? null : 'restored'
}

/** Publish resume outcome before binding so the first frame with the new terminal includes it. */
export function reportRuntimeResumeOutcome(ctx: RuntimeResumeOutcomeState): void {
  const outcome =
    ORCA_LAYOUT_OWNER_IS_MAIN && ctx.args.onResumeOutcome ? resumeOutcomeOf(ctx) : null
  if (outcome) {
    ctx.args.onResumeOutcome?.(ctx.result.id, outcome)
  }
}

/** Joiners receive attach payload at its proven kitty boundary; the caller also receives saved folder/host fields. */
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
