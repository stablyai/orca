import type { AutomationSchedulePreset } from '../../shared/automations/automation-definition'
import { RuntimeClientError } from '../runtime/connection/types'

export const PRESET_TRIGGERS = new Set<AutomationSchedulePreset>([
  'hourly',
  'daily',
  'weekdays',
  'weekly'
])

export function validateScheduleModifierApplicability(
  flags: Map<string, string | boolean>,
  raw: string
): void {
  const isPreset = PRESET_TRIGGERS.has(raw as AutomationSchedulePreset)
  if (!isPreset) {
    if (flags.has('time')) {
      throw new RuntimeClientError(
        'invalid_argument',
        '--time can only be used with preset automation triggers'
      )
    }
    if (flags.has('day')) {
      throw new RuntimeClientError(
        'invalid_argument',
        '--day can only be used with the weekly automation preset'
      )
    }
    return
  }
  if (raw === 'hourly' && flags.has('time')) {
    throw new RuntimeClientError(
      'invalid_argument',
      '--time cannot be used with the hourly automation preset; use a cron trigger such as "30 * * * *" to choose the minute'
    )
  }
  if (raw !== 'weekly' && flags.has('day')) {
    throw new RuntimeClientError(
      'invalid_argument',
      '--day can only be used with the weekly automation preset'
    )
  }
}
