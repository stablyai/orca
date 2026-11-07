import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import { resolveTerminalPalette } from '../../../shared/terminal-themes/terminal-theme-selection'
import { isDefinitiveAbsence } from '../../../shared/definitive-filesystem-absence'
import { isPlainObject, parseHooksJsonText, readHooksJson } from '../../agent-hooks/hooks-json-read'
import { writeHooksJsonAsync } from '../../agent-hooks/hooks-json-write-async'
import { getSharedManagedScriptPath, writeHooksJson } from '../../agent-hooks/installer-utils'
import { defaultClaudeConfigDir } from '../claude-config-dir-pin'
import { listClaudeProfileHomesAsync } from '../../claude-accounts/claude-profile-homes'
import { claudeCodeThemeFromTerminal, type ClaudeCodeTheme } from './claude-code-theme'

const THEME_FILE_NAME = 'orca.json'
const THEME_SETTING = 'custom:orca'
// Claude Code's built-in themes; a custom theme's base must be one of these.
const BUILT_IN_THEMES = new Set([
  'dark',
  'light',
  'dark-daltonized',
  'light-daltonized',
  'dark-ansi',
  'light-ansi'
])
const SYNC_DEBOUNCE_MS = 250
// Why: Claude Code's theme watcher misses about one replace in four; a second one lands the switch.
const RELOAD_RETRY_MS = 1_500

/** What Orca replaced in one config dir's settings.json, so turning the sync off can put it back. */
type ThemeOwnership = {
  /** null when settings.json had no theme. */
  previousTheme: string | null
  /** The user picked another theme after Orca's; Orca stops writing it. */
  userChangedTheme?: true
}

type SyncSettings = Pick<GlobalSettings, 'claudeCodeThemeSync'> &
  Parameters<typeof resolveTerminalPalette>[0]

// Why shared under ~/.orca: every Orca build on this machine must agree on what it replaced.
function ownershipPath(): string {
  return getSharedManagedScriptPath('claude-theme-sync.json')
}

async function readJson(path: string): Promise<{ value: Record<string, unknown> | null }> {
  try {
    return { value: parseHooksJsonText(await readFile(path, 'utf-8')) }
  } catch (error) {
    // Only confirmed absence reads as empty; an unreadable file must not be overwritten.
    return { value: isDefinitiveAbsence(error) ? {} : null }
  }
}

async function readOwnership(): Promise<Map<string, ThemeOwnership>> {
  const { value } = await readJson(ownershipPath())
  const owned = new Map<string, ThemeOwnership>()
  for (const [dir, entry] of Object.entries(value ?? {})) {
    if (!isPlainObject(entry)) {
      continue
    }
    const previous = entry.previousTheme
    if (typeof previous === 'string' || previous === null) {
      owned.set(dir, {
        previousTheme: previous,
        ...(entry.userChangedTheme === true ? { userChangedTheme: true } : {})
      })
    }
  }
  return owned
}

async function isDirectory(path: string): Promise<boolean> {
  return stat(path).then(
    (entry) => entry.isDirectory(),
    () => false
  )
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

/** Collects each theme file a pass replaced, so a running session's missed reload can be retried. */
type ReplacedThemeFiles = string[]

async function writeThemeFile(
  configDir: string,
  theme: ClaudeCodeTheme,
  replaced: ReplacedThemeFiles
): Promise<void> {
  const path = join(configDir, 'themes', THEME_FILE_NAME)
  const serialized = `${JSON.stringify(theme, null, 2)}\n`
  if ((await readFile(path, 'utf-8').catch(() => null)) === serialized) {
    return
  }
  await mkdir(dirname(path), { recursive: true })
  await replaceFile(path, serialized)
  replaced.push(path)
}

async function applyToConfigDir(
  configDir: string,
  theme: ClaudeCodeTheme,
  owned: ThemeOwnership | undefined,
  replaced: ReplacedThemeFiles
): Promise<ThemeOwnership | undefined> {
  // The file goes first so settings never name a theme Claude Code cannot load.
  await writeThemeFile(configDir, theme, replaced)
  if (owned?.userChangedTheme) {
    return owned
  }
  // Why sync: the hook installer edits this file synchronously too, so neither can interleave.
  const settingsPath = join(configDir, 'settings.json')
  const settings = readHooksJson(settingsPath)
  if (!settings) {
    console.warn(`[claude-theme] Skipping ${settingsPath}: it is not valid JSON`)
    return owned
  }
  const current = settings.theme
  if (owned) {
    return current === THEME_SETTING ? owned : { ...owned, userChangedTheme: true }
  }
  // Nothing to take over: the theme is already Orca's, or a value Orca could not restore exactly.
  if (current === THEME_SETTING || (current !== undefined && typeof current !== 'string')) {
    return undefined
  }
  writeHooksJson(settingsPath, { ...settings, theme: THEME_SETTING })
  return { previousTheme: current ?? null }
}

/** The look Orca's theme file takes on once released, so running sessions show the restored theme. */
async function releasedTheme(
  configDir: string,
  previousTheme: string | null,
  terminalBase: string
): Promise<ClaudeCodeTheme> {
  const custom = previousTheme?.startsWith('custom:')
    ? (await readJson(join(configDir, 'themes', `${previousTheme.slice('custom:'.length)}.json`)))
        .value
    : null
  if (custom && isPlainObject(custom.overrides)) {
    return {
      name: 'Orca',
      base:
        typeof custom.base === 'string' && BUILT_IN_THEMES.has(custom.base) ? custom.base : 'dark',
      overrides: Object.fromEntries(
        Object.entries(custom.overrides).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string'
        )
      )
    }
  }
  // Claude Code's own default is dark; `auto` follows the terminal background.
  const base =
    previousTheme === null
      ? 'dark'
      : BUILT_IN_THEMES.has(previousTheme)
        ? previousTheme
        : terminalBase
  return { name: 'Orca', base, overrides: {} }
}

/** Puts the replaced theme back; false keeps the record because settings.json could not be read. */
async function restoreConfigDir(
  configDir: string,
  owned: ThemeOwnership,
  terminalBase: string,
  replaced: ReplacedThemeFiles
): Promise<boolean> {
  if (owned.userChangedTheme || !(await isDirectory(configDir))) {
    return true
  }
  const settingsPath = join(configDir, 'settings.json')
  const settings = readHooksJson(settingsPath)
  if (!settings) {
    console.warn(`[claude-theme] Could not restore ${settingsPath}: it is not valid JSON`)
    return false
  }
  if (settings.theme !== THEME_SETTING) {
    return true
  }
  const { theme: _orcaTheme, ...rest } = settings
  writeHooksJson(
    settingsPath,
    owned.previousTheme === null ? rest : { ...settings, theme: owned.previousTheme }
  )
  await writeThemeFile(
    configDir,
    await releasedTheme(configDir, owned.previousTheme, terminalBase),
    replaced
  )
  return true
}

export type ClaudeCodeThemeSyncTarget =
  | { enabled: true; theme: ClaudeCodeTheme }
  | { enabled: false; terminalBase: string }

/** One pass over every Claude Code config dir Orca's terminals can launch with; returns the theme files it replaced. */
export async function syncClaudeCodeThemeConfigDirs(
  target: ClaudeCodeThemeSyncTarget,
  userDataPath: string
): Promise<ReplacedThemeFiles> {
  const replaced: ReplacedThemeFiles = []
  const owned = await readOwnership()
  const next = new Map(owned)
  if (target.enabled) {
    const dirs = new Set([
      defaultClaudeConfigDir(),
      ...(await listClaudeProfileHomesAsync(userDataPath))
    ])
    for (const dir of dirs) {
      if (!(await isDirectory(dir))) {
        continue
      }
      const result = await applyToConfigDir(dir, target.theme, owned.get(dir), replaced).catch(
        (error: unknown) => {
          console.warn(`[claude-theme] Could not sync ${dir}:`, error)
          return owned.get(dir)
        }
      )
      if (result) {
        next.set(dir, result)
      } else {
        next.delete(dir)
      }
    }
  } else {
    for (const [dir, entry] of owned) {
      const restored = await restoreConfigDir(dir, entry, target.terminalBase, replaced).catch(
        (error: unknown) => {
          console.warn(`[claude-theme] Could not restore ${dir}:`, error)
          return false
        }
      )
      if (restored) {
        next.delete(dir)
      }
    }
  }
  if (JSON.stringify([...owned]) !== JSON.stringify([...next])) {
    await writeHooksJsonAsync(ownershipPath(), Object.fromEntries(next))
  }
  return replaced
}

/** Replaces each file again with the content it holds now; a reload that already landed sees no change. */
async function republishThemeFiles(paths: ReplacedThemeFiles): Promise<void> {
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

/** Keeps Claude Code's theme on the terminal palette while the setting is on, and restores it when off. */
export function startClaudeCodeThemeSync(host: {
  getSettings: () => SyncSettings
  onSettingsChanged: (listener: (updates: Partial<GlobalSettings>) => void) => unknown
  systemPrefersDark: () => boolean
  onSystemThemeChanged: (listener: () => void) => unknown
  userDataPath: string
}): void {
  let lastSynced: string | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let queue = Promise.resolve()
  const sync = (): void => {
    timer = null
    const target = syncTarget(host.getSettings(), host.systemPrefersDark())
    const key = JSON.stringify(target)
    if (!target || key === lastSynced) {
      return
    }
    lastSynced = key
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
  sync()
}
