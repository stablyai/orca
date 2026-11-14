import { readFile } from 'node:fs/promises'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import { resolveTerminalPalette } from '../../../shared/terminal-themes/terminal-theme-selection'
import { claudeCodeThemeFromTerminal } from './claude-code-theme'
import { withClaudeThemeFileLock } from './claude-code-theme-ownership'
import {
  replaceFile,
  syncClaudeCodeThemeConfigDirs,
  type ClaudeCodeThemeSyncTarget
} from './claude-code-theme-sync'

const SYNC_DEBOUNCE_MS = 250
// Why: Claude Code reloads a theme only on a file event, and macOS drops some of them under load;
// each later replace is another chance, spaced out to outlast a stalled event stream.
const RELOAD_RETRY_DELAYS_MS = [1_500, 5_000, 15_000, 45_000, 120_000, 300_000]
// Catches a theme picked in Claude Code, a new account home, or a pass that failed, without polling.
const FOCUS_RESYNC_MS = 60_000

type SyncSettings = Pick<GlobalSettings, 'claudeCodeThemeSync'> &
  Parameters<typeof resolveTerminalPalette>[0]

/** Replaces the file again with the theme it holds; odd attempts add a newline so the size changes too.
 *  A session that already reloaded parses the same theme and does not repaint. */
async function republishThemeFile(path: string, attempt: number): Promise<void> {
  const content = await readFile(path, 'utf-8').catch(() => null)
  if (content !== null) {
    const canonical = `${content.trimEnd()}\n`
    await replaceFile(path, attempt % 2 === 0 ? `${canonical}\n` : canonical)
  }
}

/** Null while on but the palette has no readable colors: Orca then leaves Claude Code as it is. */
function syncTarget(
  settings: SyncSettings,
  systemPrefersDark: boolean
): ClaudeCodeThemeSyncTarget | null {
  const theme = claudeCodeThemeFromTerminal(
    resolveTerminalPalette(settings, systemPrefersDark).theme
  )
  if (settings.claudeCodeThemeSync === false) {
    return { enabled: false, terminalBase: theme?.base ?? 'dark' }
  }
  return theme ? { enabled: true, theme } : null
}

const SYNC_SETTING_KEYS: readonly (keyof GlobalSettings)[] = [
  'claudeCodeThemeSync',
  'theme',
  'terminalThemeDark',
  'terminalThemeLight',
  'terminalUseSeparateLightTheme',
  'terminalCustomThemes',
  'terminalPluginPalettes',
  'terminalColorOverrides',
  'terminalColorOverridesLight',
  'pluginSystemEnabled',
  'disabledPlugins'
]

function warnSyncFailed(error: unknown): void {
  console.warn('[claude-theme] Sync failed:', error)
}

/** Keeps Claude Code's theme on the terminal palette while the setting is on, and restores it when turned off. */
export function startClaudeCodeThemeSync(host: {
  getSettings: () => SyncSettings
  onSettingsChanged: (listener: (updates: Partial<GlobalSettings>) => void) => unknown
  systemPrefersDark: () => boolean
  onSystemThemeChanged: (listener: () => void) => unknown
  onAppFocused: (listener: () => void) => unknown
  userDataPath: string
}): void {
  let lastSynced: string | null = null
  let lastForcedAt = Date.now()
  let restorePending = false
  let timer: ReturnType<typeof setTimeout> | null = null
  // Per file, so a pass that touches one config folder keeps another folder's pending retries.
  const retryTimers = new Map<string, ReturnType<typeof setTimeout>[]>()
  let queue = Promise.resolve()
  const cancelReloadRetries = (path: string): void => {
    retryTimers.get(path)?.forEach(clearTimeout)
    retryTimers.delete(path)
  }
  const scheduleReloadRetries = (path: string): void => {
    cancelReloadRetries(path)
    retryTimers.set(
      path,
      RELOAD_RETRY_DELAYS_MS.map((delay, attempt) =>
        setTimeout(() => {
          queue = queue
            .then(() => withClaudeThemeFileLock(() => republishThemeFile(path, attempt)))
            .catch(warnSyncFailed)
        }, delay)
      )
    )
  }
  const sync = (force = false): void => {
    timer = null
    const target = syncTarget(host.getSettings(), host.systemPrefersDark())
    const key = JSON.stringify(target)
    if (!target || (key === lastSynced && !force)) {
      return
    }
    lastSynced = key
    queue = queue
      .then(async () => {
        const result = await syncClaudeCodeThemeConfigDirs(target, host.userDataPath)
        restorePending = result.restorePending
        if (!target.enabled) {
          // Off: keep retrying only the files this pass restored.
          for (const path of retryTimers.keys()) {
            if (!result.replaced.includes(path)) {
              cancelReloadRetries(path)
            }
          }
        }
        new Set(result.replaced).forEach(scheduleReloadRetries)
      })
      .catch(warnSyncFailed)
  }
  const schedule = (): void => {
    if (timer) {
      clearTimeout(timer)
    }
    timer = setTimeout(sync, SYNC_DEBOUNCE_MS)
  }
  host.onSettingsChanged((updates) => {
    if (SYNC_SETTING_KEYS.some((key) => key in updates)) {
      schedule()
    }
  })
  host.onSystemThemeChanged(schedule)
  host.onAppFocused(() => {
    if (
      (host.getSettings().claudeCodeThemeSync !== false || restorePending) &&
      Date.now() - lastForcedAt > FOCUS_RESYNC_MS
    ) {
      lastForcedAt = Date.now()
      sync(true)
    }
  })
  sync()
}
