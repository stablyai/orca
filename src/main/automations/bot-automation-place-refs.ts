// A bot automation's places (each rule's in= and subject, and where its results post) as refs, where
// the host's Orca Cloud takes them; else as the ids and keys an older cloud matches by name.
import {
  isConnectorTrigger,
  withTriggerNames,
  type AutomationConnectorEventTrigger,
  type AutomationEventTrigger
} from '../../shared/automation-event-triggers'
import { assertWorkflowRepoRef, needsWorkflows } from '../../shared/automation-github-triggers'
import type { AutomationBotResultsTo } from '../../shared/automation-bot-target'
import {
  AUTOMATION_CHANGED,
  sameAutomationEditValue,
  type AutomationEditPrecondition
} from '../../shared/automations/automation-edit-precondition'
import type {
  Automation,
  AutomationUpdateInput
} from '../../shared/automations/automation-definition'
import {
  isRefOf,
  LEGACY_PLACE_WORDS,
  LEGACY_SUBJECT_WORDS,
  legacyPlaceOf,
  legacyResultPlaceOf,
  legacySubjectOf
} from '../../shared/connector-place-names'
import {
  ConnectorRefNotFoundError,
  type ConnectorRefResolver,
  type ConnectorRefRole
} from '../connector-cloud/connector-ref-resolution'

export type BotPlaces = { on?: AutomationEventTrigger[]; resultsTo?: AutomationBotResultsTo }
type ResultPlace = Extract<AutomationBotResultsTo, object>

const NO_LOOKUP = "this computer's Orca Cloud can't look up names and links yet"
const RUN_REPO_LOOKUP =
  "github.workflow_finished needs this computer's Orca Cloud to look up the run's repo, and it can't now: try again once it's connected."

/**
 * One value as a ref, through the cloud. Where it can't say (no cloud that takes refs, a bot it
 * doesn't list yet, no answer), an id or key an older cloud matches by name is kept; anything else,
 * or what the cloud found the bot can't reach, is refused, as it would be saved and never match.
 */
async function asRef(
  resolve: ConnectorRefResolver | null,
  lookup: { botId: string; source: string; role: ConnectorRefRole; value: string },
  legacy: string | null,
  refusal: string
): Promise<{ ref: string; label?: string }> {
  if (resolve) {
    try {
      return await resolve(lookup.botId, lookup.source, lookup.role, lookup.value)
    } catch (error) {
      if (legacy === null || error instanceof ConnectorRefNotFoundError) {
        throw error
      }
    }
  }
  if (legacy === null) {
    throw new Error(refusal)
  }
  return { ref: legacy }
}

// A label that is only the ref or a bare Slack channel id names nothing a person reads.
export function shownName(
  source: string,
  found: { ref: string; label?: string }
): found is { ref: string; label: string } {
  const { ref, label } = found
  return (
    Boolean(label) &&
    label !== ref &&
    !isRefOf(source, label ?? '') &&
    (source !== 'slack' || Boolean(label?.startsWith('#')))
  )
}

/**
 * What a save names, as refs where the cloud takes them, with the names the cloud shows them by; a
 * value already saved is kept as it is, and one saved before names is looked up for its name.
 */
export async function withPlaceRefs(
  resolve: ConnectorRefResolver | null,
  botId: string,
  next: BotPlaces,
  saved: BotPlaces = {}
): Promise<BotPlaces> {
  const savedRules = (saved.on ?? []).flatMap((rule) => (isConnectorTrigger(rule) ? [rule] : []))
  const kept = new Set(
    savedRules.flatMap((rule) => [...(rule.in ?? []), ...(rule.subject ? [rule.subject] : [])])
  )
  const savedNames: Record<string, string> = Object.assign(
    {},
    ...savedRules.map((rule) => rule.names)
  )
  const ruleRef = async (
    rule: AutomationConnectorEventTrigger,
    role: ConnectorRefRole,
    value: string
  ): Promise<{ ref: string; label?: string }> => {
    if (needsWorkflows(rule)) {
      if (isRefOf(rule.source, value)) {
        assertWorkflowRepoRef(value)
      }
      if (!kept.has(value) || !isRefOf(rule.source, value)) {
        const found = await asRef(
          resolve,
          { botId, source: rule.source, role, value },
          null,
          RUN_REPO_LOOKUP
        )
        assertWorkflowRepoRef(found.ref)
        return found
      }
    }
    if (kept.has(value)) {
      if (savedNames[value] || !resolve || !isRefOf(rule.source, value)) {
        return { ref: value, label: savedNames[value] }
      }
      const found = await resolve(botId, rule.source, role, value).catch(() => null)
      return { ref: value, label: found?.label }
    }
    const [legacy, words] =
      role === 'place'
        ? [legacyPlaceOf(rule.source, value), LEGACY_PLACE_WORDS[rule.source]]
        : [legacySubjectOf(rule.source, value), LEGACY_SUBJECT_WORDS[rule.source]]
    const refusal = `${role === 'place' ? 'in=' : 'subject='} takes ${words}, not "${value}": ${NO_LOOKUP}.`
    return await asRef(resolve, { botId, source: rule.source, role, value }, legacy, refusal)
  }
  // A pull request watch names one subject on every rule: look each one up once.
  const looked = new Map<string, Promise<{ ref: string; label?: string }>>()
  const lookUp = (rule: AutomationConnectorEventTrigger, role: ConnectorRefRole, value: string) => {
    const key = JSON.stringify([rule.source, needsWorkflows(rule), role, value])
    const known = looked.get(key)
    if (known) {
      return known
    }
    const found = ruleRef(rule, role, value)
    looked.set(key, found)
    return found
  }
  const on =
    next.on &&
    (await Promise.all(
      next.on.map(async (rule): Promise<AutomationEventTrigger> => {
        if (!isConnectorTrigger(rule)) {
          return rule
        }
        const places =
          rule.in && (await Promise.all(rule.in.map((place) => lookUp(rule, 'place', place))))
        const subject = rule.subject ? await lookUp(rule, 'subject', rule.subject) : undefined
        const found = [...(places ?? []), ...(subject ? [subject] : [])].flatMap((each) =>
          shownName(rule.source, each) ? [[each.ref, each.label] as const] : []
        )
        return withTriggerNames(
          {
            ...rule,
            ...(places ? { in: [...new Set(places.map((place) => place.ref))].sort() } : {}),
            ...(subject ? { subject: subject.ref } : {})
          },
          { ...rule.names, ...Object.fromEntries(found) }
        )
      })
    ))
  const resultsTo =
    typeof next.resultsTo === 'object'
      ? await resultRef(resolve, botId, next.resultsTo, saved.resultsTo)
      : next.resultsTo
  return { ...(on ? { on } : {}), ...(resultsTo === undefined ? {} : { resultsTo }) }
}

export const resultPlaceValue = (place: ResultPlace): string =>
  'channel' in place ? place.channel : place.linearIssue

/**
 * The channel as a Slack place, the issue as a Linear subject, through the cloud. The field older
 * clients read keeps the id or key they take; new hosts post to `ref`.
 */
export async function resolvedResultPlace(
  resolve: ConnectorRefResolver,
  botId: string,
  place: ResultPlace
): Promise<ResultPlace> {
  const channel = 'channel' in place
  const value = resultPlaceValue(place)
  const found = channel
    ? await resolve(botId, 'slack', 'place', value)
    : await resolve(botId, 'linear', 'subject', value)
  const legacy = found.key ?? value
  const located = { ref: found.ref, label: found.label }
  return channel ? { channel: legacy, ...located } : { linearIssue: legacy, ...located }
}

async function resultRef(
  resolve: ConnectorRefResolver | null,
  botId: string,
  next: ResultPlace,
  saved: AutomationBotResultsTo | undefined
): Promise<ResultPlace> {
  const channel = 'channel' in next
  const value = resultPlaceValue(next)
  // An older client sends back only the id or key it shows, so the saved ref stays; a newer one, or
  // the refs pass, may send the ref with it.
  if (
    typeof saved === 'object' &&
    'channel' in saved === channel &&
    resultPlaceValue(saved) === value
  ) {
    return next.ref ? next : saved
  }
  const legacy = legacyResultPlaceOf(channel ? 'channel' : 'linearIssue', value)
  if (resolve) {
    try {
      return await resolvedResultPlace(resolve, botId, next)
    } catch (error) {
      if (legacy === null) {
        throw error
      }
    }
  }
  if (legacy === null) {
    throw new Error(
      channel
        ? `Results go to a Slack channel by its id (C0123ABCD) or link, not "${value}": ${NO_LOOKUP}.`
        : `Results go to a Linear issue by its key (ENG-123), not "${value}": ${NO_LOOKUP}.`
    )
  }
  return channel ? { channel: legacy } : { linearIssue: legacy }
}

/** An edit's rules and result place as refs, beside what the automation saved. */
export async function withPatchPlaceRefs(
  resolve: ConnectorRefResolver | null,
  botId: string,
  patch: Pick<AutomationUpdateInput, 'on' | 'bot'>,
  saved?: Pick<Automation, 'on' | 'bot'>
): Promise<Pick<AutomationUpdateInput, 'on' | 'bot'>> {
  const placed = await withPlaceRefs(
    resolve,
    botId,
    { on: patch.on, resultsTo: patch.bot?.resultsTo },
    { on: saved?.on, resultsTo: saved?.bot?.resultsTo }
  )
  return {
    ...(placed.on ? { on: placed.on } : {}),
    ...(patch.bot && placed.resultsTo ? { bot: { ...patch.bot, resultsTo: placed.resultsTo } } : {})
  }
}

/** Whether two reads of an automation have the same rules and bot target. */
export const sameBotPlaces = (
  a: Pick<Automation, 'on' | 'bot'>,
  b: Pick<Automation, 'on' | 'bot'>
) => sameAutomationEditValue([a.on, a.bot], [b.on, b.bot])

export function assertBotPlacesUnchanged(
  now: Automation,
  since: AutomationEditPrecondition | undefined
): void {
  if (
    since &&
    (!sameBotPlaces(now, since) ||
      (since.schedule &&
        !sameAutomationEditValue(since.schedule, {
          rrule: now.rrule,
          dtstart: now.dtstart,
          timezone: now.timezone,
          timezoneExplicit: now.timezoneExplicit
        })))
  ) {
    throw new Error(AUTOMATION_CHANGED)
  }
}
