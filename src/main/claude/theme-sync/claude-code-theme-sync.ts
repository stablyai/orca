import { randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import { resolveTerminalPalette } from '../../../shared/terminal-themes/terminal-theme-selection'
import { isDefinitiveAbsence } from '../../../shared/definitive-filesystem-absence'
import { readHooksJson } from '../../agent-hooks/hooks-json-read'
import { writeHooksJson } from '../../agent-hooks/installer-utils'
import { defaultClaudeConfigDir } from '../claude-config-dir-pin'
import { listClaudeProfileHomesAsync } from '../../claude-accounts/claude-profile-homes'
import {
  getClaudeObservedConfigDirs,
  getClaudeProfileRouter
} from '../../claude-accounts/claude-profile-installed-router'
import { resolveClaudeCommand } from '../../codex-cli/command'
import { claudeLoadsCustomThemes, probeRecentClaudeCliVersion } from '../claude-hook-event-versions'
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
  owned: ClaudeThemeOwnership | undefined,
  owner: string
): Promise<string[]> {
  // The file goes first so settings never name a theme Claude Code cannot load.
  const replaced = await writeThemeFile(configDir, theme)
  if (owned?.userChangedTheme) {
    return replaced
  }
  const settingsPath = join(configDir, 'settings.json')
  const current = readHooksJson(settingsPath)
  if (!current) {
    console.warn(`[claude-theme] Skipping ${settingsPath}: it is not valid JSON`)
    return replaced
  }
  if (owned) {
    if (current.theme !== THEME_SETTING) {
      await recordClaudeThemeOwnership(configDir, { ...owned, userChangedTheme: true })
    }
    return replaced
  }
  const previous = current.theme
  if (
    previous !== undefined &&
    (typeof previous !== 'string' || !REPLACEABLE_THEMES.has(previous))
  ) {
    return replaced
  }
  if (!claudeLoadsCustomThemes(await probeRecentClaudeCliVersion(resolveClaudeCommand()))) {
    return replaced
  }
  // The record lands first: a crash between the two writes must still leave a way back.
  await recordClaudeThemeOwnership(configDir, { owner, previousTheme: previous ?? null })
  // Why sync from here: Orca's hook installer edits this file synchronously, so neither interleaves.
  const settings = readHooksJson(settingsPath)
  if (!settings || settings.theme !== previous) {
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

/** Puts the replaced theme back; false keeps the record while settings.json or its dir cannot be read. */
async function restoreConfigDir(
  configDir: string,
  owned: ClaudeThemeOwnership,
  terminalBase: string,
  publishedThemeFiles: Set<string>
): Promise<{ restored: boolean; replaced: string[] }> {
  const dirState = await stat(configDir).then(
    () => 'present' as const,
    (error: unknown) => (isDefinitiveAbsence(error) ? ('gone' as const) : ('unreadable' as const))
  )
  const settingsPath = join(configDir, 'settings.json')
  const settings =
    dirState === 'unreadable' ? null : dirState === 'present' ? readHooksJson(settingsPath) : {}
  if (!settings) {
    console.warn(`[claude-theme] Could not restore ${settingsPath} yet`)
    return { restored: false, replaced: [] }
  }
  let replaced: string[] = []
  if (!owned.userChangedTheme && settings.theme === THEME_SETTING) {
    const { theme: _orcaTheme, ...rest } = settings
    writeHooksJson(
      settingsPath,
      owned.previousTheme === null ? rest : { ...settings, theme: owned.previousTheme }
    )
    // Why: account homes can share the default's themes folder; the first restored look wins.
    const themeFile = await realpath(themeFilePath(configDir)).catch(() => themeFilePath(configDir))
    if (!publishedThemeFiles.has(themeFile)) {
      publishedThemeFiles.add(themeFile)
      replaced = await writeThemeFile(configDir, releasedTheme(owned.previousTheme, terminalBase))
    }
  }
  await recordClaudeThemeOwnership(configDir, undefined)
  return { restored: true, replaced }
}

/** Where Claude Code runs from Orca: the user's own folder, account homes, and folders hooks reported. */
async function claudeConfigDirs(userDataPath: string): Promise<string[]> {
  const router = getClaudeProfileRouter()
  return [
    defaultClaudeConfigDir(router ? { CLAUDE_CONFIG_DIR: router.userConfigDir() } : process.env),
    ...(await listClaudeProfileHomesAsync(userDataPath)),
    ...(getClaudeObservedConfigDirs()?.list() ?? [])
  ]
}

export type ClaudeCodeThemeSyncResult = {
  replaced: string[]
  /** A restore this profile owes could not finish yet. */
  restorePending: boolean
}

/** One pass over every Claude Code config dir Orca's terminals can launch with. */
export async function syncClaudeCodeThemeConfigDirs(
  target: ClaudeCodeThemeSyncTarget,
  userDataPath: string
): Promise<ClaudeCodeThemeSyncResult> {
  const result: ClaudeCodeThemeSyncResult = { replaced: [], restorePending: false }
  const owned = await readClaudeThemeOwnership()
  if (!owned) {
    console.warn('[claude-theme] Skipping sync: Orca cannot read its record of replaced themes')
    return { ...result, restorePending: !target.enabled }
  }
  if (target.enabled) {
    for (const dir of new Set(await claudeConfigDirs(userDataPath))) {
      const isDir = await stat(dir).then(
        (info) => info.isDirectory(),
        () => false
      )
      if (isDir) {
        result.replaced.push(
          ...(await applyToConfigDir(dir, target.theme, owned.get(dir), userDataPath).catch(
            (error: unknown) => {
              console.warn(`[claude-theme] Could not sync ${dir}:`, error)
              return []
            }
          ))
        )
      }
    }
    return result
  }
  const published = new Set<string>()
  for (const [dir, entry] of owned) {
    if (entry.owner !== userDataPath) {
      continue
    }
    const restore = await restoreConfigDir(dir, entry, target.terminalBase, published).catch(
      (error: unknown) => {
        console.warn(`[claude-theme] Could not restore ${dir}:`, error)
        return { restored: false, replaced: [] }
      }
    )
    result.replaced.push(...restore.replaced)
    result.restorePending ||= !restore.restored
  }
  return result
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
  let restorePending = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let queue = Promise.resolve()
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
        if (result.replaced.length > 0) {
          setTimeout(() => {
            queue = queue.then(() => republishThemeFiles(result.replaced)).catch(warnSyncFailed)
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
      (host.getSettings().claudeCodeThemeSync !== false || restorePending) &&
      Date.now() - lastForcedAt > FOCUS_RESYNC_MS
    ) {
      lastForcedAt = Date.now()
      sync(true)
    }
  })
  sync()
}
