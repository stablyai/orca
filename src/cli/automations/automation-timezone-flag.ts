import { getOptionalStringFlag } from '../arguments/flags'

/** A zone given here is the owner's choice, so it holds on every host, unlike the creation default. */
export function getTimezoneFlags(flags: Map<string, string | boolean>): {
  timezone?: string
  timezoneExplicit?: true
} {
  const timezone = getOptionalStringFlag(flags, 'timezone')
  return timezone === undefined ? {} : { timezone, timezoneExplicit: true }
}
