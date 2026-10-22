import { startupCwdFallbackOutcome } from '../spawn-startup-target'
import type { RuntimePtySpawnState } from './spawn-state'
import { noteRuntimePaneCreateResult, resolvePaneSpawnReservation } from '../pane/spawn-reservation'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import type { PaneResumeOutcome } from '../../../../shared/workspace-layout/workspace-layout-published'

/** Whether a fresh start resumed the agent it was asked to; a reattach ran no launch command. */
export function resumeOutcomeOf(ctx: RuntimePtySpawnState): PaneResumeOutcome | null {
  if (!ctx.args.resumeProviderSession || ctx.result.isReattach) {
    return null
  }
  if (ctx.codexResumeUnavailable) {
    return 'resume-unavailable'
  }
  // A resume dropped silently named another agent's session: nothing came back, and nothing is owed.
  return ctx.codexResumeArgvDropped ? null : 'restored'
}

/**
 * Switch point: tells the start whether it resumed the pane's agent before the pane's bind is
 * written, so the frame that first shows the new terminal carries the outcome too.
 */
export function reportRuntimeResumeOutcome(ctx: RuntimePtySpawnState): void {
  const outcome =
    ORCA_LAYOUT_OWNER_IS_MAIN && ctx.args.onResumeOutcome ? resumeOutcomeOf(ctx) : null
  if (outcome) {
    ctx.args.onResumeOutcome?.(ctx.result.id, outcome)
  }
}

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
  const joined = {
    ...ctx.result,
    ...(typeof ctx.result.snapshotKittyKeyboardFlags === 'number' &&
    ctx.reconciledSnapshotSeq !== null &&
    ctx.snapshotKittyFlagsCoverReconciledSeq
      ? { snapshotSeq: ctx.reconciledSnapshotSeq }
      : { snapshotKittyKeyboardFlags: undefined }),
    isReattach: true as const
  }
  resolvePaneSpawnReservation(ctx.paneSpawnReservationKey, ctx.paneSpawnReservation, joined)
  // Switch point: a window view waiting on this create attaches to what it started.
  if (ORCA_LAYOUT_OWNER_IS_MAIN) {
    noteRuntimePaneCreateResult(ctx.paneSpawnReservationKey, joined)
  }
  return { ...ctx.result, ...response, wslDistro: ctx.result.wslDistro ?? undefined }
}
