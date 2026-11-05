import type { RuntimePtySpawnState } from './spawn-state'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import type { PaneResumeOutcome } from '../../../../shared/workspace-layout/workspace-layout-published'

type RuntimeResumeOutcomeState = Pick<
  RuntimePtySpawnState,
  'args' | 'result' | 'codexResumeArgvDropped'
> & { codexResumeUnavailable?: boolean }

/** Whether a fresh start resumed the agent it was asked to; a reattach ran no launch command. */
export function resumeOutcomeOf(ctx: RuntimeResumeOutcomeState): PaneResumeOutcome | null {
  if (ctx.result.isReattach) {
    return null
  }
  // Refused saved admission removes the request; the spawned shell still carries its outcome.
  if (ctx.result.agentResumeUnavailable || ctx.codexResumeUnavailable) {
    return 'resume-unavailable'
  }
  // A resume dropped silently named another agent's session: nothing came back, and nothing is owed.
  return ctx.args.resumeProviderSession && !ctx.codexResumeArgvDropped ? 'restored' : null
}

/** Publish resume outcome before binding so the first frame with the new terminal includes it. */
export function reportRuntimeResumeOutcome(ctx: RuntimeResumeOutcomeState): void {
  const outcome =
    ORCA_LAYOUT_OWNER_IS_MAIN && ctx.args.onResumeOutcome ? resumeOutcomeOf(ctx) : null
  if (outcome) {
    ctx.args.onResumeOutcome?.(ctx.result.id, outcome)
  }
}
