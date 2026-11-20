// A pull request the bot's owner opened starts a rule that takes their own events (from=me), but never
// one the bot's own work opened as them. On GitHub the bot works with its owner's account, so the
// cloud can't tell the two apart: this machine can, by the PR's head branch.
import { randomUUID } from 'node:crypto'
import type { Automation } from '../../shared/automations/automation-definition'
import type { AutomationRun } from '../../shared/automations/history/automation-run'
import { takesOwnEvents, type AutomationRunEvent } from '../../shared/automation-event-triggers'
import type { ConnectorDelivery } from '../../shared/connectors/connector-cloud-contract'
import type { EventStartGate } from '../automations/automation-trigger-runs'
import type { BotWorkPrHead } from '../bots/bot-work-pr-branch'

type TriggerDelivery = Extract<ConnectorDelivery, { kind: 'trigger' }>
type OwnPrRun = Pick<AutomationRunEvent, 'source' | 'event' | 'fromOwner' | 'place'>

export type OwnPullRequest = BotWorkPrHead

export type OwnPrGuardDeps = {
  /** Whether a bot's work on this machine opened it or has its head branch checked out. */
  isBotWork: (pr: OwnPullRequest) => Promise<boolean>
  /** The automation's runs. */
  runs: (automationId: string) => readonly Pick<AutomationRun, 'trigger' | 'createdAt' | 'event'>[]
  now?: () => number
}

/** Starts the automation on an event; the gate, when given, is asked in its lane before a new run. */
export type RunForEvent = (
  automationId: string,
  event: AutomationRunEvent,
  gate?: EventStartGate
) => Promise<AutomationRun | null>

// However the bot's work is missed, a loop of its own pull requests stops here: few people open
// more than this many pull requests in this long by hand.
export const OWN_PR_RUNS_PER_WINDOW = 5
export const OWN_PR_WINDOW_MS = 15 * 60_000

/** The pull request an own pull request event names; null for any other event, or anyone else's. */
export function ownPullRequestOf(
  run: OwnPrRun,
  delivery: Pick<TriggerDelivery, 'event'>
): OwnPullRequest | 'unknown' | null {
  const { event } = delivery
  if (run.fromOwner !== true || !takesOwnEvents(run) || event.webhook !== undefined) {
    return null
  }
  const pr = 'pr' in event ? event.pr : undefined
  if (!pr) {
    return 'unknown'
  }
  const repoId = Number(pr.repoId)
  const headRepoId = Number(pr.headRepoId ?? pr.repoId)
  const repoFullName = run.place ?? ''
  return {
    repoId,
    repoFullName,
    number: pr.number,
    // A fork's name isn't sent, so it matches by id alone.
    head: { repoId: headRepoId, repoFullName: headRepoId === repoId ? repoFullName : '' },
    headRef: pr.headRef
  }
}

/**
 * Why an owner's pull request starts nothing before it reaches the automation, or null when it may.
 * Any other event passes untouched. Without its head, it can't be told from the bot's own, so it
 * starts nothing; nor does one a bot's work opened.
 */
export async function ownPrRefusal(
  deps: Pick<OwnPrGuardDeps, 'isBotWork'>,
  run: OwnPrRun,
  delivery: Pick<TriggerDelivery, 'event'>
): Promise<'no_head' | 'bot_work' | null> {
  const pr = ownPullRequestOf(run, delivery)
  if (pr === null) {
    return null
  }
  if (pr === 'unknown') {
    return 'no_head'
  }
  return (await deps.isBotWork(pr)) ? 'bot_work' : null
}

/** Why an own pull request may not start a new run of this automation now, or null when it may. */
function ownPrStartRefusal(
  deps: Pick<OwnPrGuardDeps, 'runs' | 'now'>,
  automation: Pick<Automation, 'id' | 'on'>,
  run: Pick<AutomationRunEvent, 'triggerId'>
): 'opted_out' | 'burst' | null {
  // The rule as it is now: from=me may have come off it since the event was let through.
  const rule = automation.on?.find((entry) => entry.id === run.triggerId)
  if (!rule || !('fromOwner' in rule) || rule.fromOwner !== true) {
    return 'opted_out'
  }
  const since = (deps.now?.() ?? Date.now()) - OWN_PR_WINDOW_MS
  const recent = deps
    .runs(automation.id)
    .filter(
      (earlier) =>
        earlier.trigger === 'event' &&
        earlier.event?.fromOwner === true &&
        takesOwnEvents(earlier.event) &&
        earlier.createdAt >= since
    )
  return recent.length >= OWN_PR_RUNS_PER_WINDOW ? 'burst' : null
}

/**
 * Starts the automation on a trigger's event, unless it is an own pull request that may not. The
 * bot-work check runs first; the burst and the rule's from=me are checked in the automation's lane,
 * after resends and folds, just before its run is made, so events delivered together are counted one
 * by one and a resend uses none of the burst.
 */
export async function runOwnPrGuarded(
  deps: OwnPrGuardDeps,
  runForEvent: RunForEvent,
  event: AutomationRunEvent,
  delivery: Pick<TriggerDelivery, 'event' | 'automationId'>
): Promise<boolean> {
  const own = ownPullRequestOf(event, delivery) !== null
  const refused = await ownPrRefusal(deps, event, delivery)
  if (refused) {
    console.info(`[bots] an own pull request started nothing (${refused})`)
    return false
  }
  const gate: EventStartGate | undefined = own
    ? {
        reserve: async (automation) => {
          const refusal = ownPrStartRefusal(deps, automation, event)
          if (refusal) {
            console.info(`[bots] an own pull request started nothing (${refusal})`)
            return { refused: true }
          }
          return { event, runId: randomUUID() }
        },
        created: () => {}
      }
    : undefined
  return Boolean(await runForEvent(delivery.automationId, event, gate))
}
