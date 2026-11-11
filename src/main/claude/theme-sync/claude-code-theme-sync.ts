import { randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { isDefinitiveAbsence } from '../../../shared/definitive-filesystem-absence'
import { readHooksJson } from '../../agent-hooks/installation/configuration/hooks-json-read'
import { writeHooksJson } from '../../agent-hooks/installation/configuration/hooks-json-write'
import { defaultClaudeConfigDir } from '../claude-config-dir-pin'
import { listClaudeProfileHomesAsync } from '../../claude-accounts/profiles/claude-profile-homes'
import {
  getClaudeObservedConfigDirs,
  getClaudeProfileRouter
} from '../../claude-accounts/profiles/routing/claude-profile-installed-router'
import { resolveClaudeCommand } from '../../codex-cli/command'
import { claudeLoadsCustomThemes, probeRecentClaudeCliVersion } from '../claude-hook-event-versions'
import type { ClaudeCodeTheme } from './claude-code-theme'
import {
  readClaudeThemeOwnership,
  withClaudeThemeOwnership,
  type ClaudeThemeOwnership
} from './claude-code-theme-ownership'

const THEME_SETTING = 'custom:orca'
// Why only these: colorblind and ANSI-only themes, and the user's own custom ones, were picked on purpose.
const REPLACEABLE_THEMES = new Set(['dark', 'light', 'auto'])

export type ClaudeCodeThemeSyncTarget =
  | { enabled: true; theme: ClaudeCodeTheme }
  | { enabled: false; terminalBase: string }

function themeFilePath(configDir: string): string {
  return join(configDir, 'themes', 'orca.json')
}

/** Atomic so Claude Code's theme watcher never reads a half-written file. */
export async function replaceFile(path: string, content: string): Promise<void> {
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
  // trimEnd: a reload retry may have left one extra newline.
  if ((await readFile(path, 'utf-8').catch(() => null))?.trimEnd() === serialized.trimEnd()) {
    return []
  }
  await mkdir(dirname(path), { recursive: true })
  await replaceFile(path, serialized)
  return [path]
}

function isReplaceableTheme(theme: unknown): boolean {
  return theme === undefined || (typeof theme === 'string' && REPLACEABLE_THEMES.has(theme))
}

async function applyToConfigDir(
  configDir: string,
  theme: ClaudeCodeTheme,
  owner: string,
  recorded: ClaudeThemeOwnership | undefined
): Promise<string[]> {
  // The file goes first so settings never name a theme Claude Code cannot load.
  const replaced = await writeThemeFile(configDir, theme)
  const settingsPath = join(configDir, 'settings.json')
  const unlocked = readHooksJson(settingsPath)
  if (!unlocked) {
    console.warn(`[claude-theme] Skipping ${settingsPath}: it is not valid JSON`)
    return replaced
  }
  // Lock-free check: most passes leave settings.json and the record as they are.
  const mayChange = recorded
    ? !recorded.userChangedTheme && unlocked.theme !== THEME_SETTING
    : isReplaceableTheme(unlocked.theme)
  // Probe outside the lock: it spawns Claude Code, and only a first takeover needs it.
  if (
    !mayChange ||
    (!recorded &&
      !claudeLoadsCustomThemes(await probeRecentClaudeCliVersion(resolveClaudeCommand())))
  ) {
    return replaced
  }
  await withClaudeThemeOwnership(configDir, async ({ entry, save }) => {
    if (entry?.userChangedTheme) {
      return
    }
    // Why sync reads and writes: Orca's in-process hook installer edits this file synchronously.
    const settings = readHooksJson(settingsPath)
    if (!settings) {
      return
    }
    if (entry) {
      if (settings.theme !== THEME_SETTING) {
        await save({ ...entry, userChangedTheme: true })
      }
      return
    }
    if (!isReplaceableTheme(settings.theme)) {
      return
    }
    // Under the lock, so another Orca's restore cannot leave its look in the file Orca now selects.
    replaced.push(...(await writeThemeFile(configDir, theme)))
    // The record lands first: a crash between the two writes must still leave a way back.
    await save({
      owner,
      previousTheme: typeof settings.theme === 'string' ? settings.theme : null
    })
    // Reread after the last await: Claude Code or the hook installer may have saved meanwhile.
    const current = readHooksJson(settingsPath)
    if (!current || current.theme !== settings.theme) {
      await save(undefined)
      return
    }
    try {
      writeHooksJson(settingsPath, { ...current, theme: THEME_SETTING })
    } catch (error) {
      // Without this, the next pass would read the unchanged theme as the user's own pick.
      await save(undefined)
      throw error
    }
  }).catch((error: unknown) => {
    console.warn(`[claude-theme] Could not select the Orca theme in ${settingsPath}:`, error)
  })
  return replaced
}

/** The look Orca's theme file takes on once released, so running sessions show the restored theme. */
function releasedTheme(previousTheme: string | null, terminalBase: string): ClaudeCodeTheme {
  // Claude Code's own default is dark; `auto` follows the terminal background.
  const base =
    previousTheme === null ? 'dark' : previousTheme === 'auto' ? terminalBase : previousTheme
  return { name: 'Orca', base, overrides: {} }
}

/** Writes the replaced theme back into settings.json; the theme to show running sessions, if it reverted. */
function revertSettings(
  settingsPath: string,
  entry: ClaudeThemeOwnership,
  dirState: 'present' | 'gone' | 'unreadable'
): { restored: boolean; previousTheme?: string | null } {
  const settings =
    dirState === 'unreadable' ? null : dirState === 'present' ? readHooksJson(settingsPath) : {}
  if (!settings) {
    console.warn(`[claude-theme] Could not restore ${settingsPath} yet`)
    return { restored: false }
  }
  if (entry.userChangedTheme) {
    return { restored: true }
  }
  if (settings.theme !== THEME_SETTING) {
    // Already reverted by a pass whose theme-file write failed; that write is still owed.
    const reverted = settings.theme === (entry.previousTheme ?? undefined)
    return reverted ? { restored: true, previousTheme: entry.previousTheme } : { restored: true }
  }
  const { theme: _orcaTheme, ...rest } = settings
  writeHooksJson(
    settingsPath,
    entry.previousTheme === null ? rest : { ...settings, theme: entry.previousTheme }
  )
  return { restored: true, previousTheme: entry.previousTheme }
}

/** Puts the replaced theme back; false keeps the record while settings.json or its dir cannot be read. */
async function restoreConfigDir(
  configDir: string,
  recorded: ClaudeThemeOwnership,
  terminalBase: string,
  publishedThemeFiles: Set<string>
): Promise<{ restored: boolean; replaced: string[] }> {
  const dirState = await stat(configDir).then(
    () => 'present' as const,
    (error: unknown) => (isDefinitiveAbsence(error) ? ('gone' as const) : ('unreadable' as const))
  )
  const settingsPath = join(configDir, 'settings.json')
  return await withClaudeThemeOwnership(configDir, async ({ entry, save }) => {
    if (!entry || entry.owner !== recorded.owner) {
      return { restored: true, replaced: [] }
    }
    const reverted = revertSettings(settingsPath, entry, dirState)
    if (!reverted.restored) {
      return { restored: false, replaced: [] }
    }
    // Why: account homes can share the default's themes folder; the first restored look wins.
    const themeFile = await realpath(themeFilePath(configDir)).catch(() => themeFilePath(configDir))
    let replaced: string[] = []
    if (reverted.previousTheme !== undefined && !publishedThemeFiles.has(themeFile)) {
      // Under the lock and before the record goes, so a failed write is retried and cannot
      // overwrite the theme another Orca selects right after.
      replaced = await writeThemeFile(
        configDir,
        releasedTheme(reverted.previousTheme, terminalBase)
      )
      publishedThemeFiles.add(themeFile)
    }
    await save(undefined)
    return { restored: true, replaced }
  }).catch((error: unknown) => {
    console.warn(`[claude-theme] Could not restore ${settingsPath} yet:`, error)
    return { restored: false, replaced: [] }
  })
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
          ...(await applyToConfigDir(dir, target.theme, userDataPath, owned.get(dir)).catch(
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
