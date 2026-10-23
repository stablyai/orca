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

/**
 * Switch point: tells the start whether it resumed the pane's agent before the pane's bind is
 * written, so the frame that first shows the new terminal carries the outcome too.
 */
export function reportRuntimeResumeOutcome(ctx: RuntimeResumeOutcomeState): void {
  const outcome =
    ORCA_LAYOUT_OWNER_IS_MAIN && ctx.args.onResumeOutcome ? resumeOutcomeOf(ctx) : null
  if (outcome) {
    ctx.args.onResumeOutcome?.(ctx.result.id, outcome)
  }
}
