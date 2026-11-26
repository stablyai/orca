// The rules a host checks itself (Gmail, Calendar and ngit), each worded by its own spec.
import type { AutomationEventSource } from '../../shared/automation-event-triggers'
import {
  isGoogleTrigger,
  type AutomationGoogleTrigger
} from '../../shared/automation-google-triggers'
import type { AutomationNgitTrigger } from '../../shared/automation-ngit-triggers'
import {
  describeGoogleTrigger,
  formatGoogleTrigger,
  GOOGLE_TRIGGER_OPTIONS,
  parseGoogleTrigger
} from '../google/google-event-trigger-spec'
import {
  describeNgitTrigger,
  formatNgitTrigger,
  NGIT_TRIGGER_OPTIONS,
  parseNgitTrigger
} from '../ngit/ngit-event-trigger-spec'

type HostTrigger = AutomationGoogleTrigger | AutomationNgitTrigger

/** Null for an event no host checks; `entries` is read only for one that is. */
export function parseHostTrigger(
  spec: string,
  head: string,
  entries: () => Parameters<typeof parseNgitTrigger>[2]
): HostTrigger | null {
  if (head === 'gmail.new_email' || head === 'calendar.starting_soon') {
    return parseGoogleTrigger(spec, head, entries())
  }
  return head.startsWith('ngit.') ? parseNgitTrigger(spec, head, entries()) : null
}

export function formatHostTrigger(trigger: HostTrigger, quote: (value: string) => string): string {
  return isGoogleTrigger(trigger) ? formatGoogleTrigger(trigger) : formatNgitTrigger(trigger, quote)
}

export function describeHostTrigger(trigger: HostTrigger): string {
  return isGoogleTrigger(trigger) ? describeGoogleTrigger(trigger) : describeNgitTrigger(trigger)
}

/** `silentBot`: the bot these can't start, when Google is off for it. */
export function hostTriggerOptions(
  source: AutomationEventSource,
  silentBot: string | null
): string {
  if (source !== 'gmail' && source !== 'calendar') {
    return NGIT_TRIGGER_OPTIONS
  }
  return silentBot
    ? `${source}: none of these start ${silentBot}: Google is off for it. Its owner can turn it on with \`orca google bot "${silentBot}" --on\`.`
    : GOOGLE_TRIGGER_OPTIONS[source]
}
