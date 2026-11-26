import { getCalendars, getLocales } from 'expo-localization'
import type { OsDateTimeRegion } from '../../../src/shared/i18n/regional-date-time-format'

// The phone's Region setting and 12/24-hour clock, which it keeps apart from the app language.
export function readDeviceDateTimeRegion(): OsDateTimeRegion {
  try {
    const uses24hourClock = getCalendars()[0]?.uses24hourClock
    return {
      region: getLocales()[0]?.regionCode ?? null,
      hourCycle: uses24hourClock == null ? null : uses24hourClock ? 'h23' : 'h12'
    }
  } catch {
    return { region: null, hourCycle: null }
  }
}
