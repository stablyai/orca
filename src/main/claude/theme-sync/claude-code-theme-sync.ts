import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import { resolveTerminalPalette } from '../../../shared/terminal-themes/terminal-theme-selection'
import { isDefinitiveAbsence } from '../../../shared/definitive-filesystem-absence'
import { readHooksJson } from '../../agent-hooks/hooks-json-read'
import { writeHooksJson } from '../../agent-hooks/installer-utils'
import { defaultClaudeConfigDir } from '../claude-config-dir-pin'
import { listClaudeProfileHomesAsync } from '../../claude-accounts/claude-profile-homes'
import { claudeCodeThemeFromTerminal, type ClaudeCodeTheme } from './claude-code-theme'
import {
  readClaudeThemeOwnership,
  recordClaudeThemeOwnership,
  type ClaudeThemeOwnership
} from './claude-code-theme-ownership'

const THEME_SETTING = 'custom:orca'
// Why only these: colorblind and ANSI-only themes, and the user's own custom ones, were picked on purpose.
const REPLACEABLE_THEMES = new Set(['dark', 'light', 'auto'])
const SYNC_DEBOUNCE_MS = 250
// Why: a congested macOS file-event stream can drop Claude Code's reload; a second replace lands it.
const RELOAD_RETRY_MS = 1_500
// Catches a theme picked in Claude Code, a new account home, or a pass that failed, without polling.
const FOCUS_RESYNC_MS = 60_000

type SyncSettings = Pick<GlobalSettings, 'claudeCodeThemeSync'> &
  Parameters<typeof resolveTerminalPalette>[0]

export type ClaudeCodeThemeSyncTarget =
  | { enabled: true; theme: ClaudeCodeTheme }
  | { enabled: false; terminalBase: string }

function themeFilePath(configDir: string): string {
  return join(configDir, 'themes', 'orca.json')
}

/** Atomic so Claude Code's theme watcher never reads a half-written file. */
async function replaceFile(path: string, content: string): Promise<void> {
  // Why not .json: Claude Code only loads .json files, so it never sees the temp file as a theme.
  const tmp = join(dirname(path), `.orca-${randomUUID()}.tmp`)
  try {
    await writeFile(tmp, content, 'utf-8')
    await rename(tmp, path)
  } finally {
    await rm(tmp, { force: true })
  }
}

/** Returns the path when it replaced the file, for the reload retry. */
async function writeThemeFile(configDir: string, theme: ClaudeCodeTheme): Promise<string[]> {
  const path = themeFilePath(configDir)
  const serialized = `${JSON.stringify(theme, null, 2)}\n`
  if ((await readFile(path, 'utf-8').catch(() => null)) === serialized) {
    return []
  }
  await mkdir(dirname(path), { recursive: true })
  await replaceFile(path, serialized)
  return [path]
}

async function applyToConfigDir(
  configDir: string,
  theme: ClaudeCodeTheme,
  owned: ClaudeThemeOwnership | undefined
): Promise<string[]> {
  // The file goes first so settings never name a theme Claude Code cannot load.
  const replaced = await writeThemeFile(configDir, theme)
  if (owned?.userChangedTheme) {
    return replaced
  }
  const settingsPath = join(configDir, 'settings.json')
  const current = readHooksJson(settingsPath)?.theme
  if (owned) {
    if (current !== THEME_SETTING) {
      await recordClaudeThemeOwnership(configDir, { ...owned, userChangedTheme: true })
    }
    return replaced
  }
  if (current !== undefined && (typeof current !== 'string' || !REPLACEABLE_THEMES.has(current))) {
    return replaced
  }
  // The record lands first: a crash between the two writes must still leave a way back.
  await recordClaudeThemeOwnership(configDir, { previousTheme: current ?? null })
  // Why sync from here: Orca's hook installer edits this file synchronously, so neither interleaves.
  const settings = readHooksJson(settingsPath)
  if (!settings || settings.theme !== current) {
    console.warn(`[claude-theme] Skipping ${settingsPath}: unreadable or changed during sync`)
    await recordClaudeThemeOwnership(configDir, undefined)
    return replaced
  }
  writeHooksJson(settingsPath, { ...settings, theme: THEME_SETTING })
  return replaced
}

/** The look Orca's theme file takes on once released, so running sessions show the restored theme. */
function releasedTheme(previousTheme: string | null, terminalBase: string): ClaudeCodeTheme {
  // Claude Code's own default is dark; `auto` follows the terminal background.
  const base =
    previousTheme === null ? 'dark' : previousTheme === 'auto' ? terminalBase : previousTheme
  return { name: 'Orca', base, overrides: {} }
}

/** Puts the replaced theme back; keeps the record while settings.json or its dir cannot be read. */
async function restoreConfigDir(
  configDir: string,
  owned: ClaudeThemeOwnership,
  terminalBase: string
): Promise<string[]> {
  const dirState = await stat(configDir).then(
    () => 'present' as const,
    (error: unknown) => (isDefinitiveAbsence(error) ? ('gone' as const) : ('unreadable' as const))
  )
  if (dirState === 'unreadable') {
    return []
  }
  const settingsPath = join(configDir, 'settings.json')
  const settings = dirState === 'present' ? readHooksJson(settingsPath) : {}
  if (!settings) {
    console.warn(`[claude-theme] Could not restore ${settingsPath}: it is not valid JSON`)
    return []
  }
  let replaced: string[] = []
  if (!owned.userChangedTheme && settings.theme === THEME_SETTING) {
    const { theme: _orcaTheme, ...rest } = settings
    writeHooksJson(
      settingsPath,
      owned.previousTheme === null ? rest : { ...settings, theme: owned.previousTheme }
    )
    replaced = await writeThemeFile(configDir, releasedTheme(owned.previousTheme, terminalBase))
  }
  await recordClaudeThemeOwnership(configDir, undefined)
  return replaced
}

/** One pass over every Claude Code config dir Orca's terminals can launch with; returns the theme files it replaced. */
export async function syncClaudeCodeThemeConfigDirs(
  target: ClaudeCodeThemeSyncTarget,
  userDataPath: string
): Promise<string[]> {
  const owned = await readClaudeThemeOwnership()
  if (!owned) {
    console.warn('[claude-theme] Skipping sync: Orca cannot read its record of replaced themes')
    return []
  }
  const dirs = target.enabled
    ? [defaultClaudeConfigDir(), ...(await listClaudeProfileHomesAsync(userDataPath))]
    : [...owned.keys()]
  const replaced: string[] = []
  for (const dir of new Set(dirs)) {
    const entry = owned.get(dir)
    const pass = target.enabled
      ? stat(dir).then(
          (info) => (info.isDirectory() ? applyToConfigDir(dir, target.theme, entry) : []),
          () => []
        )
      : entry
        ? restoreConfigDir(dir, entry, target.terminalBase)
        : Promise.resolve([])
    replaced.push(
      ...(await pass.catch((error: unknown) => {
        console.warn(`[claude-theme] Could not sync ${dir}:`, error)
        return []
      }))
    )
  }
  return replaced
}

/** Replaces each file again with the content it holds now; a reload that already landed sees no change. */
async function republishThemeFiles(paths: readonly string[]): Promise<void> {
  for (const path of paths) {
    const content = await readFile(path, 'utf-8').catch(() => null)
    if (content !== null) {
      await replaceFile(path, content)
    }
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
  // Why: only turning it off here restores; a build left off must not undo another build's sync at launch.
  let restoreWhenOff = host.getSettings().claudeCodeThemeSync !== false
  let timer: ReturnType<typeof setTimeout> | null = null
  let queue = Promise.resolve()
  const sync = (force = false): void => {
    timer = null
    const target = syncTarget(host.getSettings(), host.systemPrefersDark())
    const key = JSON.stringify(target)
    if (!target || (key === lastSynced && !force) || (!target.enabled && !restoreWhenOff)) {
      return
    }
    lastSynced = key
    restoreWhenOff = target.enabled
    queue = queue
      .then(async () => {
        const replaced = await syncClaudeCodeThemeConfigDirs(target, host.userDataPath)
        if (replaced.length > 0) {
          setTimeout(() => {
            queue = queue.then(() => republishThemeFiles(replaced)).catch(warnSyncFailed)
          }, RELOAD_RETRY_MS)
        }
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
      host.getSettings().claudeCodeThemeSync !== false &&
      Date.now() - lastForcedAt > FOCUS_RESYNC_MS
    ) {
      lastForcedAt = Date.now()
      sync(true)
    }
  })
  sync()
}
