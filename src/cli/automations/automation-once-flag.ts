// --once and --by: a bot automation that runs a single time, on its first event or at a deadline.
import type { AutomationOnce } from '../../shared/automation-once'
import { getOptionalStringFlag } from '../arguments/flags'
import { hasImpossibleLeadingDate } from '../arguments/calendar-date'
import { RuntimeClientError } from '../runtime/connection/types'

/** The wait --once and --by ask for; undefined when neither is given. */
export function getOnceFlags(flags: Map<string, string | boolean>): AutomationOnce | undefined {
  const once = flags.get('once')
  if (typeof once === 'string') {
    throw new RuntimeClientError('invalid_argument', '--once does not take a value')
  }
  const raw = getOptionalStringFlag(flags, 'by')
  if (raw === undefined) {
    return once === true ? {} : undefined
  }
  if (once !== true) {
    throw new RuntimeClientError('invalid_argument', '--by needs --once')
  }
  const by = hasImpossibleLeadingDate(raw) ? Number.NaN : Date.parse(raw)
  if (Number.isFinite(by) && by <= Date.now()) {
    throw new RuntimeClientError('invalid_argument', '--by must be a time in the future')
  }
  if (!Number.isFinite(by)) {
    throw new RuntimeClientError(
      'invalid_argument',
      '--by must be a date and time, such as 2026-11-06T17:00:00-05:00'
    )
  }
  return { by }
}
