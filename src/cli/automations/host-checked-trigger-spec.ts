// The --on rules this host checks itself (Gmail, Calendar, Teams): each one's parse, format, words
// and options, by source.
import { isGoogleTrigger } from '../../shared/automation-google-triggers'
import type {
  AutomationHostCheckedTrigger,
  HostCheckedSource
} from '../../shared/automation-host-checked-triggers'
import {
  describeGoogleTrigger,
  formatGoogleTrigger,
  GOOGLE_TRIGGER_OPTIONS,
  parseGoogleTrigger
} from '../google/google-event-trigger-spec'
import {
  describeTeamsTrigger,
  formatTeamsTrigger,
  parseTeamsTrigger,
  TEAMS_TRIGGER_OPTIONS
} from '../teams/teams-event-trigger-spec'

type Entry = readonly [key: string, value: string, ...written: string[]]

/** The rule, or null when `event` isn't one this host checks; `entries` is read only for one that is. */
export function parseHostCheckedTrigger(
  spec: string,
  event: string,
  entries: () => readonly Entry[]
): AutomationHostCheckedTrigger | null {
  if (event === 'gmail.new_email' || event === 'calendar.starting_soon') {
    return parseGoogleTrigger(spec, event, entries())
  }
  return event === 'teams.mentioned' ? parseTeamsTrigger(spec, entries()) : null
}

export function formatHostCheckedTrigger(trigger: AutomationHostCheckedTrigger): string {
  return isGoogleTrigger(trigger) ? formatGoogleTrigger(trigger) : formatTeamsTrigger(trigger)
}

export function describeHostCheckedTrigger(trigger: AutomationHostCheckedTrigger): string {
  return isGoogleTrigger(trigger) ? describeGoogleTrigger(trigger) : describeTeamsTrigger(trigger)
}

/** A source's options; for a bot it doesn't start, the one line its owner needs instead. */
export function hostCheckedTriggerOptions(
  source: HostCheckedSource,
  bot: { name: string } | undefined,
  heard: readonly string[] | undefined
): string {
  const off = bot !== undefined && !heard?.includes(source)
  if (source === 'teams') {
    return off
      ? `teams: none of these start ${bot.name}: Teams is off for it. Its owner can turn it on with \`orca teams bot "${bot.name}" --on\`.`
      : TEAMS_TRIGGER_OPTIONS
  }
  return off
    ? `${source}: none of these start ${bot.name}: Google is off for it. Its owner can turn it on with \`orca google bot "${bot.name}" --on\`.`
    : GOOGLE_TRIGGER_OPTIONS[source]
}
