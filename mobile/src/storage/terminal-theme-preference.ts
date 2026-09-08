import AsyncStorage from '@react-native-async-storage/async-storage'

export type MobileTerminalThemeMode = 'system' | 'dark' | 'light' | 'desktop'

const TERMINAL_THEME_MODE_KEY = 'orca:terminalThemeMode'
const listeners = new Set<() => void>()
let mode: MobileTerminalThemeMode = 'system'
let initialized = false
let loadPromise: Promise<MobileTerminalThemeMode> | null = null
let writeBarrier: Promise<void> = Promise.resolve()

export function getMobileTerminalThemeMode(): MobileTerminalThemeMode {
  return mode
}

export function subscribeMobileTerminalThemeMode(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function publish(next: MobileTerminalThemeMode): void {
  if (next === mode) {
    return
  }
  mode = next
  for (const listener of listeners) {
    listener()
  }
}

export function loadMobileTerminalThemeMode(): Promise<MobileTerminalThemeMode> {
  if (initialized) {
    return Promise.resolve(mode)
  }
  loadPromise ??= AsyncStorage.getItem(TERMINAL_THEME_MODE_KEY)
    .then((stored) => {
      // A user choice made during hydration already owns the complete preference.
      if (!initialized) {
        if (
          stored !== null &&
          stored !== 'system' &&
          stored !== 'dark' &&
          stored !== 'light' &&
          stored !== 'desktop'
        ) {
          throw new Error('Invalid stored terminal theme mode')
        }
        initialized = true
        publish(stored ?? 'system')
      }
      return mode
    })
    .finally(() => {
      loadPromise = null
    })
  return loadPromise
}

export function saveMobileTerminalThemeMode(next: MobileTerminalThemeMode): Promise<void> {
  initialized = true
  publish(next)
  const write = writeBarrier.then(() => AsyncStorage.setItem(TERMINAL_THEME_MODE_KEY, next))
  // Recover only the queue; the caller still receives the failed write for its error UI.
  writeBarrier = write.catch(() => undefined)
  return write
}
