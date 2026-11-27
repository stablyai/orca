// One scheduler tick: each automation whose time came, a wait at its deadline or expiry included.
import type { Automation } from '../../shared/automations/automation-definition'
import { onceClaimed, onceDueAt, onceRunFinished } from '../../shared/automation-once'
import { AutomationDispatchCancelledError } from './dispatch/automation-dispatch-cancelled-error'
import { recordUnevaluableAutomation } from './dispatch/dispatch-refusal'
import { runScheduledOccurrence, type AutomationTriggerRunContext } from './automation-trigger-runs'

/** Runs what is due, in list order; a malformed one never stops the rest. */
export async function runDueAutomations(input: {
  ctx: AutomationTriggerRunContext
  now: number
  /** False once the service stops or restarts; nothing more starts. */
  isActive: () => boolean
  captureTarget: (listed: Automation) => Automation
}): Promise<void> {
  const { ctx, now } = input
  for (const automation of ctx.store.listAutomations()) {
    if (!input.isActive()) {
      break
    }
    if (automation.once && (await removeFinishedWait(ctx, automation.id))) {
      continue
    }
    if (!automation.enabled || (onceDueAt(automation) ?? automation.nextRunAt) > now) {
      continue
    }
    try {
      await (automation.once
        ? runOnceDue(ctx, automation.id, now)
        : runScheduledOccurrence(ctx, input.captureTarget(automation), now))
    } catch (error) {
      if (
        !(error instanceof AutomationDispatchCancelledError) &&
        input.isActive() &&
        ctx.store.listAutomations().some((current) => current.id === automation.id)
      ) {
        await recordUnevaluableAutomation({ runs: ctx.runs, automation, error })
      }
    }
  }
}

/** A wait goes once its one run has finished, however it ended; true when it went. */
async function removeFinishedWait(
  ctx: AutomationTriggerRunContext,
  automationId: string
): Promise<boolean> {
  if (!ctx.once || !onceRunFinished(ctx.store.listAutomationRuns(automationId))) {
    return false
  }
  try {
    await ctx.once.remove(automationId)
    return true
  } catch (error) {
    console.warn('[automations] could not remove a finished wait:', error)
    return false
  }
}

/**
 * A wait at its deadline runs once, knowing the deadline came first; one with no deadline expires
 * unrun. Claimed in the automation's lane, so an event admitted there first wins and this starts nothing.
 */
export async function runOnceDue(
  ctx: AutomationTriggerRunContext,
  automationId: string,
  now: number
): Promise<void> {
  const admitted = await ctx.inLane(automationId, async () => {
    const automation = ctx.store.listAutomations().find((entry) => entry.id === automationId)
    const dueAt = automation ? onceDueAt(automation) : null
    if (
      !automation?.enabled ||
      dueAt === null ||
      dueAt > now ||
      onceClaimed(ctx.store.listAutomationRuns(automationId))
    ) {
      return null
    }
    if (automation.once?.by === undefined) {
      await ctx.once?.expire(automation)
      return null
    }
    const target = ctx.resolveTarget(automation)
    const refusal = await ctx.describeRefusal(target)
    // A refused deadline run claims nothing, so the next tick tries again.
    if (refusal && (await ctx.runs.repeatSkip(automationId, refusal.error, dueAt))) {
      return null
    }
    const run = await ctx.runs.createRun(automation, dueAt, 'scheduled')
    return { automation, run, target }
  })
  if (admitted) {
    await ctx.dispatch(admitted.automation, admitted.run, admitted.target)
  }
}
