import { app, systemPreferences } from 'electron'
import {
  hourCycleFromTimePattern,
  osLocaleRegion,
  setOsDateTimeRegion,
  type OsDateTimeRegion
} from '../../shared/i18n/regional-date-time-format'
import { loadWindowsNativeRegistry, WINDOWS_REG_SZ } from '../windows/windows-native-registry'

let snapshot: OsDateTimeRegion | undefined

// macOS keeps the 24-hour toggle apart from the region; either key overrides the region's default.
function macHourCycle(): OsDateTimeRegion['hourCycle'] {
  if (systemPreferences.getUserDefault('AppleICUForce24HourTime', 'boolean')) {
    return 'h23'
  }
  return systemPreferences.getUserDefault('AppleICUForce12HourTime', 'boolean') ? 'h12' : null
}

// Windows stores a hand-edited clock as the short-time pattern; the native addon reads it in-process.
function windowsHourCycle(): OsDateTimeRegion['hourCycle'] {
  const registry = loadWindowsNativeRegistry()
  const entry = registry.getRegistryKey(registry.HK.CU, 'Control Panel\\International')?.sShortTime
  return entry?.type === WINDOWS_REG_SZ && typeof entry.value === 'string'
    ? hourCycleFromTimePattern(entry.value)
    : null
}

function readOsDateTimeRegion(): OsDateTimeRegion {
  if (process.platform === 'linux') {
    // Chromium's locale is the messages language; LC_TIME is the clock's own setting.
    const env = process.env
    return { region: osLocaleRegion(env.LC_ALL || env.LC_TIME || env.LANG), hourCycle: null }
  }
  const region = osLocaleRegion(app.getSystemLocale())
  try {
    return {
      region,
      hourCycle: process.platform === 'darwin' ? macHourCycle() : windowsHourCycle()
    }
  } catch {
    return { region, hourCycle: null }
  }
}

/** Read once, beside window creation (or before a startup dialog); a changed OS setting applies on the next launch. */
export function getOsDateTimeRegion(): OsDateTimeRegion | null {
  if (!app.isReady()) {
    return null
  }
  if (snapshot === undefined) {
    try {
      snapshot = readOsDateTimeRegion()
    } catch {
      snapshot = { region: null, hourCycle: null }
    }
    // Main's own formats (notifications) follow the same clock from here on.
    setOsDateTimeRegion(snapshot)
  }
  return snapshot
}
