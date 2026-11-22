import type { Automation } from '../../shared/automations/automation-definition'
import type { AutomationRun } from '../../shared/automations/history/automation-run'
import { runHasEvent, type AutomationRunEvent } from '../../shared/automation-event-triggers'
import type { Store } from '../persistence/loading-store/store'
import type { AutomationRunWriter } from './run-history/run-writer'
import type { AutomationRunTargetResult } from './ownership/run-target-resolution'
import { missedBeyondGrace, recordMissedRun } from './dispatch/dispatch-refusal'
import type { AutomationRunFailure } from '../../shared/automations/history/automation-run-failure-copy'
import { onceClaimed } from '../../shared/automation-once'

/** What a wait does beyond a run, whose run row is how its chat shows it ended: its expiry with no
 *  run, and its deletion after the run. */
export type AutomationOnceEffects = {
  /** No deadline, and nothing came: Orca says so and deletes it, starting no agent. */
  expire(automation: Automation): Promise<void>
  /** Its one run has finished. */
  remove(automationId: string): Promise<unknown>
}

export type AutomationTriggerRunContext = {
  store: Pick<Store, 'listAutomations' | 'listAutomationRuns' | 'getLatestAutomationOccurrence'>
  runs: AutomationRunWriter
  /** The wait the wake gate imposed before this scheduler pass. */
  wakeGateDelayMs: number
  /** The automation's dispatch lane; the operation must not dispatch itself. */
  inLane<T>(automationId: string, operation: () => Promise<T>): Promise<T>
  describeRefusal(target: AutomationRunTargetResult): Promise<AutomationRunFailure | null>
  resolveTarget(automation: Automation): AutomationRunTargetResult
  dispatch(
    automation: Automation,
    run: AutomationRun,
    target: AutomationRunTargetResult
  ): Promise<AutomationRun>
  /** Detached so due runs start together; `afterCreate` runs first, ahead of a blocked lane. */
  launch(
    automation: Automation,
    run: AutomationRun,
    target: AutomationRunTargetResult,
    afterCreate?: () => Promise<unknown>
  ): void
  once: AutomationOnceEffects | null
}

export async function runScheduledOccurrence(
  ctx: AutomationTriggerRunContext,
  automation: Automation,
  now: number
): Promise<void> {
  const scheduledFor = ctx.store.getLatestAutomationOccurrence(automation, now)
  if (scheduledFor === null) {
    await ctx.runs.advanceNextRun(automation.id, now)
    return
  }
  if (missedBeyondGrace({ automation, scheduledFor, now, wakeGateDelayMs: ctx.wakeGateDelayMs })) {
    await recordMissedRun({ runs: ctx.runs, automation, scheduledFor })
    await ctx.runs.advanceNextRun(automation.id, now)
    return
  }

  // Fold recurring refusals before creating rows so they do not evict real run history.
  const target = ctx.resolveTarget(automation)
  const refusal = await ctx.describeRefusal(target)
  // Once WSL owns the schedule, avoid churning skips on the retained local copy.
  if (refusal?.errorCode === 'wslMoveOwnedByHost') {
    await ctx.runs.advanceNextRun(automation.id, now)
    return
  }
  if (refusal && (await ctx.runs.repeatSkip(automation.id, refusal.error, scheduledFor))) {
    await ctx.runs.advanceNextRun(automation.id, now)
    return
  }

  const run = await ctx.runs.createRun(automation, scheduledFor)
  ctx.launch(automation, run, target, () => ctx.runs.advanceNextRun(automation.id, now))
}

/**
 * Asked inside the automation's lane just before an event would start a new run, never for a fold, a
 * miss or a refusal. reserve may hold the event until a time (it starts nothing and is offered again
 * then), refuse it (it starts nothing), or give the event to start with and the id the run must have;
 * created sees the run before it is launched.
 */
export type EventStartGate = {
  reserve(
    automation: Automation
  ): Promise<{ retryAt: number } | { refused: true } | { event: AutomationRunEvent; runId: string }>
  created(run: AutomationRun): void
}

/** The event was a message the bot answered: its turn, in this chat, ran it instead of a run of its own. */
export type EventInTurn = { inTurn: { worktreeId: string; sessionId: string } | null }

export type EventRunOptions = EventStartGate | EventInTurn

type EventAdmission = {
  run: AutomationRun
  launch?: { automation: Automation; target: AutomationRunTargetResult }
}

/** Dedupe on the source's key, fold repeats on a subject, apply Grace, then run as a schedule would. */
export async function runForEvent(
  ctx: AutomationTriggerRunContext,
  automationId: string,
  event: AutomationRunEvent,
  gate?: EventRunOptions
): Promise<AutomationRun | null> {
  if (gate && 'inTurn' in gate) {
    return await recordRunInTurn(ctx, automationId, event, gate.inTurn)
  }
  // Admit one event at a time, so two on one subject cannot both miss the run to fold into.
  const admitted = await ctx.inLane(automationId, () => admitEvent(ctx, automationId, event, gate))
  if (!admitted?.launch) {
    return admitted?.run ?? null
  }
  return await ctx.dispatch(admitted.launch.automation, admitted.run, admitted.launch.target)
}

async function admitEvent(
  ctx: AutomationTriggerRunContext,
  automationId: string,
  event: AutomationRunEvent,
  gate: EventStartGate | undefined
): Promise<EventAdmission | null> {
  const automation = takingAutomation(ctx.store, automationId, event)
  // A wait whose run started, on an event or its deadline, takes nothing more.
  if (!automation || (automation.once && onceClaimed(ctx.store.listAutomationRuns(automationId)))) {
    return null
  }
  const seen = eventRun(ctx.store, automationId, event)
  const folded = seen ?? (await ctx.runs.foldEvent(automationId, event))
  if (folded) {
    return { run: folded }
  }
  const scheduledFor = event.occurredAt
  // Events are never wake-gated, so no settle wait is credited.
  if (missedBeyondGrace({ automation, scheduledFor, now: Date.now(), wakeGateDelayMs: 0 })) {
    return { run: await recordMissedRun({ runs: ctx.runs, automation, scheduledFor, event }) }
  }
  const target = ctx.resolveTarget(automation)
  const refusal = await ctx.describeRefusal(target)
  const repeated = refusal
    ? await ctx.runs.repeatSkip(automationId, refusal.error, scheduledFor, event)
    : null
  if (repeated) {
    return { run: repeated }
  }
  const reserved = refusal || !gate ? null : await gate.reserve(automation)
  if (reserved && !('event' in reserved)) {
    return null
  }
  const run = await ctx.runs.createRun(
    automation,
    scheduledFor,
    'event',
    reserved?.event ?? event,
    reserved?.runId
  )
  if (reserved) {
    gate?.created(run)
  }
  return { run, launch: { automation, target } }
}

/** The automation, while it takes the event; one from before it existed (a source's late resend) starts nothing. */
export function takingAutomation(
  store: Pick<Store, 'listAutomations'>,
  automationId: string,
  event: AutomationRunEvent
): Automation | null {
  const automation = store.listAutomations().find((entry) => entry.id === automationId)
  return automation?.enabled &&
    event.occurredAt >= automation.createdAt &&
    automation.on?.some((trigger) => trigger.id === event.triggerId)
    ? automation
    : null
}

/** The run the source event already reached, if any. */
export function eventRun(
  store: Pick<Store, 'listAutomationRuns'>,
  automationId: string,
  event: Pick<AutomationRunEvent, 'key'>
): AutomationRun | undefined {
  return store
    .listAutomationRuns(automationId)
    .find((run) => run.trigger === 'event' && runHasEvent(run, event.key))
}

/**
 * An event a bot's conversation turn ran instead of a run of its own: recorded in the automation's
 * history as handled there, so a resend of it starts nothing. Null once the automation no longer
 * takes it, or another run already has it.
 */
async function recordRunInTurn(
  ctx: Pick<AutomationTriggerRunContext, 'store' | 'runs' | 'inLane'>,
  automationId: string,
  event: AutomationRunEvent,
  chat: EventInTurn['inTurn']
): Promise<AutomationRun | null> {
  return await ctx.inLane(automationId, async () => {
    const automation = takingAutomation(ctx.store, automationId, event)
    if (!automation || eventRun(ctx.store, automationId, event)) {
      return null
    }
    const run = await ctx.runs.createRun(automation, event.occurredAt, 'event', event)
    return await ctx.runs.updateRun({
      runId: run.id,
      status: 'completed',
      handledInTurn: true,
      ...(chat
        ? { sessionKind: 'chat', chatSessionId: chat.sessionId, workspaceId: chat.worktreeId }
        : {})
    })
  })
}

/** Run now on an event automation replays its latest event, so it does what the next event would. */
export function latestAutomationEvent(
  store: Pick<Store, 'listAutomationRuns'>,
  automation: Automation
): AutomationRunEvent | undefined {
  if (!automation.on) {
    return undefined
  }
  // A run's event is the latest one folded into it, so pick by when events happened.
  return store
    .listAutomationRuns(automation.id)
    .map((run) => run.event)
    .reduce<AutomationRunEvent | undefined>(
      (latest, event) =>
        event && (!latest || event.occurredAt > latest.occurredAt) ? event : latest,
      undefined
    )
}
