import { app, BrowserWindow, ipcMain, nativeTheme } from 'electron'
import { existsSync, watch, type FSWatcher } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { GlobalSettings } from '../shared/global-settings-types'
import {
  deriveOmarchyPalette,
  isOmarchyTerminalThemeSelected,
  parseOmarchyThemeSeed,
  upsertOmarchyTerminalTheme,
  type OmarchyThemePalette
} from '../shared/omarchy-theme-palette'

type OmarchyThemeStore = {
  getSettings: () => GlobalSettings
  updateSettings: (
    updates: Partial<GlobalSettings>,
    options?: { notifyListeners?: boolean }
  ) => GlobalSettings
  onSettingsChanged: (listener: (updates: Partial<GlobalSettings>) => void) => () => void
}

// Why: `omarchy theme set` rm+mv's `current/theme`, so only its parent survives a switch.
const OMARCHY_CURRENT_DIR = join(homedir(), '.local', 'state', 'omarchy', 'current')
const ORCA_THEME_FILE = join(OMARCHY_CURRENT_DIR, 'theme', 'orca.json')
const CHANGE_DEBOUNCE_MS = 150
// Selecting Omarchy from any writer (RPC, another window) must refresh theme/terminal entries now.
const OMARCHY_SELECTION_KEYS: readonly (keyof GlobalSettings)[] = [
  'omarchyTheme',
  'terminalThemeDark',
  'terminalThemeLight',
  'terminalUseSeparateLightTheme'
]

/** Reads this machine's rendered palette; never consults SSH/remote hosts. */
export async function readOmarchyThemePalette(
  filePath = ORCA_THEME_FILE,
  platform: NodeJS.Platform = process.platform
): Promise<OmarchyThemePalette | null> {
  if (platform !== 'linux') {
    return null
  }
  let text: string
  try {
    text = await readFile(filePath, 'utf8')
  } catch {
    return null
  }
  const seed = parseOmarchyThemeSeed(text)
  return seed ? deriveOmarchyPalette(seed) : null
}

function isOmarchyThemeWanted(settings: GlobalSettings): boolean {
  return settings.omarchyTheme === true || isOmarchyTerminalThemeSelected(settings)
}

export function registerOmarchyThemeHandlers(store: OmarchyThemeStore): void {
  ipcMain.handle('settings:readOmarchyTheme', () => readOmarchyThemePalette())

  if (process.platform !== 'linux') {
    return
  }

  let watcher: FSWatcher | null = null
  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  let lastPublished: string | null = null

  const publish = async (): Promise<void> => {
    const palette = await readOmarchyThemePalette()
    // Missing, unresolved, or invalid: keep the last good palette in place.
    if (!palette || !watcher) {
      return
    }
    const settings = store.getSettings()
    const updates: Partial<GlobalSettings> = {}
    if (settings.omarchyTheme === true && settings.theme !== palette.seed.mode) {
      updates.theme = palette.seed.mode
      nativeTheme.themeSource = palette.seed.mode
    }
    if (isOmarchyTerminalThemeSelected(settings)) {
      const themes = upsertOmarchyTerminalTheme(settings.terminalCustomThemes, palette.seed)
      if (themes) {
        updates.terminalCustomThemes = themes
      }
    }
    if (Object.keys(updates).length > 0) {
      store.updateSettings(updates, { notifyListeners: true })
    }
    const serialized = JSON.stringify(palette)
    if (serialized === lastPublished) {
      return
    }
    lastPublished = serialized
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send('settings:omarchyThemeChanged', palette)
      }
    }
  }

  const stop = (): void => {
    if (debounceTimer) {
      clearTimeout(debounceTimer)
      debounceTimer = null
    }
    watcher?.close()
    watcher = null
    lastPublished = null
  }

  const sync = (): void => {
    if (!isOmarchyThemeWanted(store.getSettings())) {
      stop()
      return
    }
    // The file only gates starting: mid-switch it is briefly absent between rm and mv.
    if (watcher || !existsSync(ORCA_THEME_FILE)) {
      return
    }
    try {
      watcher = watch(OMARCHY_CURRENT_DIR, { persistent: false }, () => {
        if (debounceTimer) {
          clearTimeout(debounceTimer)
        }
        // A theme switch rewrites many entries at once; read after it settles.
        debounceTimer = setTimeout(() => {
          debounceTimer = null
          void publish()
        }, CHANGE_DEBOUNCE_MS)
      })
      watcher.on('error', stop)
    } catch {
      watcher = null
      return
    }
    // Catch up on a switch made while the option was off or Orca was closed.
    void publish()
  }

  store.onSettingsChanged((updates) => {
    const wasWatching = watcher !== null
    sync()
    if (wasWatching && watcher && OMARCHY_SELECTION_KEYS.some((key) => key in updates)) {
      void publish()
    }
  })
  app.on('will-quit', stop)
  sync()
}
