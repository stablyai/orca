import AsyncStorage from '@react-native-async-storage/async-storage'
import { getBuiltinTerminalThemePalette } from '../../../src/shared/terminal-themes'

/** Device-local terminal palette choice. A `null` slot follows the desktop-pushed palette. */
export type MobileTerminalThemeSelection = {
  readonly dark: string | null
  readonly light: string | null
  readonly useSeparateLightTheme: boolean
}

const DARK_KEY = 'orca:terminalThemeDark'
const LIGHT_KEY = 'orca:terminalThemeLight'
const SEPARATE_LIGHT_KEY = 'orca:terminalUseSeparateLightTheme'

// Why: an absent key IS "follow desktop", so a fresh install and an explicit
// choice are the same state; the separate-light default mirrors desktop's
// shipped `terminalUseSeparateLightTheme` (src/shared/constants.ts).
export const DEFAULT_MOBILE_TERMINAL_THEME_SELECTION: MobileTerminalThemeSelection = {
  dark: null,
  light: null,
  useSeparateLightTheme: true
}

const listeners = new Set<() => void>()
let selection: MobileTerminalThemeSelection = DEFAULT_MOBILE_TERMINAL_THEME_SELECTION
let loadPromise: Promise<MobileTerminalThemeSelection> | null = null
let hydrated = false
let pendingPatch: Partial<MobileTerminalThemeSelection> = {}

export function getMobileTerminalThemeSelection(): MobileTerminalThemeSelection {
  return selection
}

export function subscribeMobileTerminalThemeSelection(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

// Why: useSyncExternalStore compares snapshots by reference, and an unchanged
// load must not repaint every mounted terminal.
function publish(next: MobileTerminalThemeSelection): void {
  if (
    next.dark === selection.dark &&
    next.light === selection.light &&
    next.useSeparateLightTheme === selection.useSeparateLightTheme
  ) {
    return
  }
  selection = next
  for (const listener of listeners) {
    listener()
  }
}

// Why: a stale or hand-edited name degrades to "follow desktop" rather than a blank terminal.
function readSlot(raw: string | null): string | null {
  return raw && getBuiltinTerminalThemePalette(raw) ? raw : null
}

async function readStoredSelection(): Promise<MobileTerminalThemeSelection> {
  let stored: (string | null)[]
  try {
    stored = await Promise.all([
      AsyncStorage.getItem(DARK_KEY),
      AsyncStorage.getItem(LIGHT_KEY),
      AsyncStorage.getItem(SEPARATE_LIGHT_KEY)
    ])
  } catch {
    // Why: memoising a failed read would pin the default for the whole session.
    loadPromise = null
    return selection
  }
  hydrated = true
  const loaded = {
    dark: readSlot(stored[0] ?? null),
    light: readSlot(stored[1] ?? null),
    useSeparateLightTheme: stored[2] !== 'false'
  }
  publish({ ...loaded, ...pendingPatch })
  pendingPatch = {}
  return selection
}

/** Memoised: the device is the sole writer and every write republishes. */
export function loadMobileTerminalThemeSelection(): Promise<MobileTerminalThemeSelection> {
  if (!loadPromise) {
    loadPromise = readStoredSelection()
  }
  return loadPromise
}

export async function saveMobileTerminalThemeSelection(
  patch: Partial<MobileTerminalThemeSelection>
): Promise<void> {
  if (!hydrated) {
    pendingPatch = { ...pendingPatch, ...patch }
    // Why: the tap must not wait for the read, but merging onto the pre-load
    // default would erase the two slots this patch never touches.
    publish({ ...selection, ...patch })
    // Why: the awaited value is a boot snapshot; `selection` below is the live merge base.
    await loadMobileTerminalThemeSelection()
  }
  const next = { ...selection, ...patch }
  // Why: publish before the write so live panes repaint without awaiting storage.
  publish(next)
  // Why: a failed read leaves `hydrated` false and the merge base at the in-memory
  // default, so only the patched slots may be written — the rest would overwrite
  // whatever is really on disk.
  const writes: Promise<void>[] = []
  if (hydrated || patch.dark !== undefined) {
    writes.push(writeSlot(DARK_KEY, next.dark))
  }
  if (hydrated || patch.light !== undefined) {
    writes.push(writeSlot(LIGHT_KEY, next.light))
  }
  if (hydrated || patch.useSeparateLightTheme !== undefined) {
    writes.push(AsyncStorage.setItem(SEPARATE_LIGHT_KEY, String(next.useSeparateLightTheme)))
  }
  await Promise.all(writes)
}

function writeSlot(key: string, name: string | null): Promise<void> {
  return name === null ? AsyncStorage.removeItem(key) : AsyncStorage.setItem(key, name)
}
