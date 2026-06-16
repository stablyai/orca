import AsyncStorage from '@react-native-async-storage/async-storage'

const PINS_PREFIX = 'orca:pins:'
const NOTIF_KEY = 'orca:pushNotificationsEnabled'

// Why: default-off so the iOS notification permission prompt never
// fires until the user explicitly opts in via Settings → Notifications.
// Apple's review guideline 4.5.4 and HIG both prefer user-initiated
// permission prompts; default-on would fire the prompt the moment the
// desktop sent its first notification, which can read as unsolicited.
export async function loadPushNotificationsEnabled(): Promise<boolean> {
  try {
    const raw = await AsyncStorage.getItem(NOTIF_KEY)
    if (raw === null) {
      return false
    }
    return raw === 'true'
  } catch {
    return false
  }
}

export async function savePushNotificationsEnabled(enabled: boolean): Promise<void> {
  await AsyncStorage.setItem(NOTIF_KEY, String(enabled))
}

const TEXT_SCALE_KEY = 'orca:terminalTextScale'

// Why: the mobile terminal fits the desktop's full column count to the phone
// width with a CSS scale, so xterm's raw fontSize is cancelled out and can't
// drive apparent size. Instead we persist a baseline zoom multiplier ("text
// size") that the WebView applies on top of the fit. Discrete presets keep the
// settings picker simple and bound the value to ones the zoom logic handles;
// pinch-to-zoom in the terminal snaps to these same presets. Sub-1 steps shrink
// below fit-to-width (more columns visible with side margins).
export const TERMINAL_TEXT_SCALES = [0.5, 0.75, 1, 1.25, 1.5, 2] as const
const DEFAULT_TEXT_SCALE = 1

export async function loadTerminalTextScale(): Promise<number> {
  try {
    const raw = await AsyncStorage.getItem(TEXT_SCALE_KEY)
    if (raw === null) {
      return DEFAULT_TEXT_SCALE
    }
    const parsed = Number(raw)
    return (TERMINAL_TEXT_SCALES as readonly number[]).includes(parsed)
      ? parsed
      : DEFAULT_TEXT_SCALE
  } catch {
    return DEFAULT_TEXT_SCALE
  }
}

export async function saveTerminalTextScale(scale: number): Promise<void> {
  await AsyncStorage.setItem(TEXT_SCALE_KEY, String(scale))
}

const AUTOCOMPLETE_KEY = 'orca:terminalAutocompleteEnabled'

// Why: terminal command inputs default to autocorrect/suggestions OFF so the
// keyboard never mangles commands, flags, or paths. Users who want phone-style
// typing opt in via Settings → Terminal; the choice persists locally per device.
export async function loadTerminalAutocompleteEnabled(): Promise<boolean> {
  try {
    const raw = await AsyncStorage.getItem(AUTOCOMPLETE_KEY)
    return raw === 'true'
  } catch {
    return false
  }
}

export async function saveTerminalAutocompleteEnabled(enabled: boolean): Promise<void> {
  await AsyncStorage.setItem(AUTOCOMPLETE_KEY, String(enabled))
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

export async function loadPinnedIds(hostId: string): Promise<Set<string>> {
  try {
    const raw = await AsyncStorage.getItem(PINS_PREFIX + hostId)
    if (!raw) {
      return new Set()
    }
    return new Set(stringArray(JSON.parse(raw)))
  } catch {
    return new Set()
  }
}

export async function savePinnedIds(hostId: string, ids: Set<string>): Promise<void> {
  await AsyncStorage.setItem(PINS_PREFIX + hostId, JSON.stringify([...ids]))
}
