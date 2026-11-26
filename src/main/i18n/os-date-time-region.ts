import { app, systemPreferences } from 'electron'
import { runProcess } from '@orca/process-host'
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

const GSETTINGS_TIMEOUT_MS = 2_000
let desktopClock: Promise<OsDateTimeRegion | null> | undefined

// GNOME keeps its 12/24-hour choice in gsettings, apart from LC_TIME. Other desktops, headless hosts
// and SSH sessions have no such setting to follow.
function isGnomeDesktop(env: NodeJS.ProcessEnv): boolean {
  const desktops = (env.XDG_CURRENT_DESKTOP ?? '').toUpperCase().split(':')
  return desktops.includes('GNOME') && Boolean(env.DISPLAY || env.WAYLAND_DISPLAY)
}

async function gnomeHourCycle(): Promise<OsDateTimeRegion['hourCycle']> {
  try {
    const result = await runProcess({
      program: 'gsettings',
      args: ['get', 'org.gnome.desktop.interface', 'clock-format'],
      timeoutMs: GSETTINGS_TIMEOUT_MS,
      maxOutputBytes: 64
    })
    const value = result.timedOut || result.code !== 0 ? '' : result.stdout.trim()
    return value === "'24h'" ? 'h23' : value === "'12h'" ? 'h12' : null
  } catch {
    // No gsettings on this machine.
    return null
  }
}

/** What windows get: the snapshot, plus GNOME's clock choice read once, async, when a window first asks. */
export function getOsDateTimeRegionForWindow(): Promise<OsDateTimeRegion | null> {
  const base = getOsDateTimeRegion()
  if (base === null || process.platform !== 'linux' || !isGnomeDesktop(process.env)) {
    return Promise.resolve(base)
  }
  desktopClock ??= gnomeHourCycle().then((hourCycle) => {
    if (hourCycle !== null && snapshot !== undefined) {
      snapshot = { ...snapshot, hourCycle }
      setOsDateTimeRegion(snapshot)
    }
    return snapshot ?? base
  })
  return desktopClock
}
