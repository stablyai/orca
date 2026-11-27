import { getOptionalStringFlag } from '../arguments/flags'
import { RuntimeClientError } from '../runtime/connection/types'
import {
  isKnownTimeZone,
  unknownTimeZoneMessage
} from '../../shared/automations/scheduling/automation-schedule-calendar'

/** A zone given here is the owner's choice, so it holds on every host, unlike the creation default. */
export function getTimezoneFlags(flags: Map<string, string | boolean>): {
  timezone?: string
  timezoneExplicit?: true
} {
  const timezone = getOptionalStringFlag(flags, 'timezone')
  if (timezone === undefined) {
    return {}
  }
  if (!isKnownTimeZone(timezone)) {
    throw new RuntimeClientError('invalid_argument', unknownTimeZoneMessage(timezone))
  }
  return { timezone, timezoneExplicit: true }
}
