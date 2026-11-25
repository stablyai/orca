// A rule's `from` as each source's user ids. What a person or bot wrote (@name, a name, or an id) is
// looked up among the people the bot's connector sees, through Orca Cloud.
import {
  isConnectorTrigger,
  withTriggerNames,
  type AutomationConnectorEventTrigger,
  type AutomationEventTrigger
} from '../../shared/automation-event-triggers'
import {
  needsCiFinished,
  needsGitHub2,
  needsWorkflows
} from '../../shared/automation-github-triggers'
import { botLinearWorkspaces, botSlackApps, type Bot } from '../../shared/bot-types'
import type { BotsCloudClient } from '../connector-cloud/bots-cloud-client'

type Person = { id: string; name: string }
/** The people a source lists for the query; null when Orca Cloud can't say now. */
export type TriggerPeopleSearch = (
  source: AutomationConnectorEventTrigger['source'],
  query: string
) => Promise<Person[] | null>

const PERSON_ID: Record<AutomationConnectorEventTrigger['source'], RegExp> = {
  slack: /^[UW][A-Z0-9]{2,}$/,
  github: /^\d+$/,
  linear: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
}

export const OWN_TRIGGERS_UNSUPPORTED =
  "This computer's Orca Cloud doesn't take from=me yet: leave it out, or try again after it updates."

/**
 * A new rule that your own pull requests start is refused where Orca Cloud can't take it: an older
 * cloud drops `fromOwner` and never sends them. One already saved stays, as the people filters do.
 */
export function assertOwnTriggers(
  takesOwn: boolean,
  on: readonly AutomationEventTrigger[] | undefined,
  saved: readonly AutomationEventTrigger[] = []
): void {
  const kept = new Set(
    saved.flatMap((rule) => (isConnectorTrigger(rule) && rule.fromOwner ? [rule.id] : []))
  )
  const added = (on ?? []).some(
    (rule) => isConnectorTrigger(rule) && rule.fromOwner && !kept.has(rule.id)
  )
  if (added && !takesOwn) {
    throw new Error(OWN_TRIGGERS_UNSUPPORTED)
  }
}

export const GITHUB2_TRIGGERS_UNSUPPORTED =
  "This computer's Orca Cloud doesn't send that GitHub event (or label=) yet: wait on another event, or try again after it updates."

/** A new rule this host's Orca Cloud can't send is refused (an older cloud keeps it and never fires
 *  it); one already saved stays. */
function refuseNewRules(
  takes: boolean,
  needs: (rule: AutomationEventTrigger) => boolean,
  refusal: string,
  on: readonly AutomationEventTrigger[] | undefined,
  saved: readonly AutomationEventTrigger[]
): void {
  const kept = new Set(saved.filter(needs).map((rule) => rule.id))
  if (!takes && (on ?? []).some((rule) => needs(rule) && !kept.has(rule.id))) {
    throw new Error(refusal)
  }
}

export const WORKFLOW_TRIGGERS_UNSUPPORTED =
  "This computer's Orca Cloud doesn't send github.workflow_finished yet: make it a reminder at the time the run should be done (--once --by), or try again after it updates."

export const CI_FINISHED_TRIGGERS_UNSUPPORTED =
  "This computer's Orca Cloud doesn't send github.ci_finished yet: wait on github.ci_passed and github.ci_failed instead, or try again after it updates."

/** What this host's Orca Cloud takes: rules on your own pull requests (`triggers.own`), GitHub's
 *  newer events and label= (`triggers.github2`), finished workflow runs (`triggers.workflows`) and
 *  finished CI (`triggers.ci_finished`). */
export type CloudTriggers = {
  own: boolean
  github2: boolean
  workflows: boolean
  ciFinished: boolean
}

/** The refusals above, for the rules this host's Orca Cloud takes as `takes` says. */
export function assertCloudTakesTriggers(
  takes: CloudTriggers,
  on: readonly AutomationEventTrigger[] | undefined,
  saved: readonly AutomationEventTrigger[] = []
): void {
  assertOwnTriggers(takes.own, on, saved)
  refuseNewRules(takes.github2, needsGitHub2, GITHUB2_TRIGGERS_UNSUPPORTED, on, saved)
  refuseNewRules(takes.workflows, needsWorkflows, WORKFLOW_TRIGGERS_UNSUPPORTED, on, saved)
  refuseNewRules(takes.ciFinished, needsCiFinished, CI_FINISHED_TRIGGERS_UNSUPPORTED, on, saved)
}

export const TRIGGER_PEOPLE_UNSUPPORTED =
  "This computer's Orca Cloud doesn't take from= or on=mine yet: leave them out, or try again after it updates."

/**
 * Each rule's `from` as ids, with the names they were found by, keeping what was saved; a name that matches no one person exactly is
 * refused with who it could be. Null search: Orca Cloud doesn't take these filters yet, so a new one
 * is refused rather than saved for a cloud that would ignore it.
 */
export async function withTriggerPeople(
  search: TriggerPeopleSearch | null,
  on: AutomationEventTrigger[] | undefined,
  saved: readonly AutomationEventTrigger[] = []
): Promise<AutomationEventTrigger[] | undefined> {
  if (!on) {
    return on
  }
  const kept = new Set(saved.flatMap((rule) => (isConnectorTrigger(rule) ? (rule.from ?? []) : [])))
  const savedNames: Record<string, string> = Object.assign(
    {},
    ...saved.map((rule) => (isConnectorTrigger(rule) ? rule.names : {}))
  )
  const keptMine = new Set(
    saved.flatMap((rule) => (!isConnectorTrigger(rule) || !rule.onOwnerMessage ? [] : [rule.id]))
  )
  return await Promise.all(
    on.map(async (rule): Promise<AutomationEventTrigger> => {
      if (!isConnectorTrigger(rule)) {
        return rule
      }
      if (rule.onOwnerMessage && !search && !keptMine.has(rule.id)) {
        throw new Error(TRIGGER_PEOPLE_UNSUPPORTED)
      }
      if (!rule.from?.length) {
        return rule
      }
      const people = await Promise.all(
        rule.from.map(async (who) =>
          kept.has(who)
            ? { id: who, name: savedNames[who] }
            : await person(search, rule.source, who)
        )
      )
      const from = [...new Set(people.map((each) => each.id))].sort()
      const found = people.flatMap((each) => (each.name ? [[each.id, each.name] as const] : []))
      return withTriggerNames({ ...rule, from }, { ...rule.names, ...Object.fromEntries(found) })
    })
  )
}

// An id as written carries no name: the cloud's people search matches names only.
async function person(
  search: TriggerPeopleSearch | null,
  source: AutomationConnectorEventTrigger['source'],
  written: string
): Promise<{ id: string; name?: string }> {
  if (!search) {
    throw new Error(TRIGGER_PEOPLE_UNSUPPORTED)
  }
  if (PERSON_ID[source].test(written)) {
    return { id: written }
  }
  const query = written.replace(/^@/, '').trim()
  const found = await search(source, query)
  if (found === null) {
    throw new Error(`Orca Cloud couldn't look up "${written}" right now. Try again in a moment.`)
  }
  const exact = found.filter((person) => person.name.toLowerCase() === query.toLowerCase())
  const [only] = exact
  if (only && exact.length === 1) {
    return only
  }
  const listed = (exact.length > 0 ? exact : found)
    .slice(0, 10)
    .map((person) => `${person.id} (${person.name})`)
  throw new Error(
    listed.length === 0
      ? `No one the bot sees in ${source} is named "${written}".`
      : `"${written}" names no one person exactly; pass one of these ids: ${listed.join(', ')}`
  )
}

/**
 * The people each of the bot's connectors lists, through Orca Cloud, in every workspace it is in; one
 * name in two workspaces is two people. Null only when no workspace could say.
 */
export function cloudTriggerPeopleSearch(
  client: BotsCloudClient,
  bot: Pick<Bot, 'id' | 'slack' | 'slackApps' | 'linear' | 'linearWorkspaces'>
): TriggerPeopleSearch {
  return async (source, query) => {
    const lookups =
      source === 'slack'
        ? botSlackApps(bot).map((app) => client.slackMembers(bot.id, query, app.teamId))
        : source === 'linear'
          ? botLinearWorkspaces(bot).map((linear) =>
              client.linearMembers(linear.workspaceId, query)
            )
          : [client.githubUsers(query)]
    const listed = await Promise.all(lookups)
    return listed.some((result) => result.ok)
      ? listed.flatMap((result) => (result.ok ? result.value.members : []))
      : null
  }
}
