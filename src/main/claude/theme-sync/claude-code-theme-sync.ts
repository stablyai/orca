import { randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
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
import type { ClaudeCodeTheme } from './claude-code-theme'
import { readClaudeThemeOwnership, withClaudeThemeOwnership } from './claude-code-theme-ownership'

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
  owner: string
): Promise<string[]> {
  // The file goes first so settings never name a theme Claude Code cannot load.
  const replaced = await writeThemeFile(configDir, theme)
  const settingsPath = join(configDir, 'settings.json')
  // Probe outside the lock: it spawns Claude Code, and only a first takeover needs it.
  const supported =
    isReplaceableTheme(readHooksJson(settingsPath)?.theme) &&
    claudeLoadsCustomThemes(await probeRecentClaudeCliVersion(resolveClaudeCommand()))
  await withClaudeThemeOwnership(configDir, async ({ entry, save }) => {
    if (entry?.userChangedTheme) {
      return
    }
    // Why sync reads and writes: Orca's in-process hook installer edits this file synchronously.
    const settings = readHooksJson(settingsPath)
    if (!settings) {
      console.warn(`[claude-theme] Skipping ${settingsPath}: it is not valid JSON`)
      return
    }
    if (entry) {
      if (settings.theme !== THEME_SETTING) {
        await save({ ...entry, userChangedTheme: true })
      }
      return
    }
    if (!supported || !isReplaceableTheme(settings.theme)) {
      return
    }
    const previous = typeof settings.theme === 'string' ? settings.theme : null
    // The record lands first: a crash between the two writes must still leave a way back.
    await save({ owner, previousTheme: previous })
    const current = readHooksJson(settingsPath)
    if (!current || current.theme !== settings.theme) {
      await save(undefined)
      return
    }
    writeHooksJson(settingsPath, { ...current, theme: THEME_SETTING })
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

/** Puts the replaced theme back; false keeps the record while settings.json or its dir cannot be read. */
async function restoreConfigDir(
  configDir: string,
  owner: string,
  terminalBase: string,
  publishedThemeFiles: Set<string>
): Promise<{ restored: boolean; replaced: string[] }> {
  const dirState = await stat(configDir).then(
    () => 'present' as const,
    (error: unknown) => (isDefinitiveAbsence(error) ? ('gone' as const) : ('unreadable' as const))
  )
  const settingsPath = join(configDir, 'settings.json')
  const restoredTheme = await withClaudeThemeOwnership(configDir, async ({ entry, save }) => {
    if (!entry || entry.owner !== owner) {
      return { restored: true, previousTheme: undefined }
    }
    const settings =
      dirState === 'unreadable' ? null : dirState === 'present' ? readHooksJson(settingsPath) : {}
    if (!settings) {
      console.warn(`[claude-theme] Could not restore ${settingsPath} yet`)
      return { restored: false, previousTheme: undefined }
    }
    const reverts = !entry.userChangedTheme && settings.theme === THEME_SETTING
    if (reverts) {
      const { theme: _orcaTheme, ...rest } = settings
      writeHooksJson(
        settingsPath,
        entry.previousTheme === null ? rest : { ...settings, theme: entry.previousTheme }
      )
    }
    await save(undefined)
    return { restored: true, previousTheme: reverts ? entry.previousTheme : undefined }
  })
  if (restoredTheme.previousTheme === undefined) {
    return { restored: restoredTheme.restored, replaced: [] }
  }
  // Why: account homes can share the default's themes folder; the first restored look wins.
  const themeFile = await realpath(themeFilePath(configDir)).catch(() => themeFilePath(configDir))
  if (publishedThemeFiles.has(themeFile)) {
    return { restored: true, replaced: [] }
  }
  publishedThemeFiles.add(themeFile)
  return {
    restored: true,
    replaced: await writeThemeFile(
      configDir,
      releasedTheme(restoredTheme.previousTheme, terminalBase)
    )
  }
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
          ...(await applyToConfigDir(dir, target.theme, userDataPath).catch((error: unknown) => {
            console.warn(`[claude-theme] Could not sync ${dir}:`, error)
            return []
          }))
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
    const restore = await restoreConfigDir(dir, userDataPath, target.terminalBase, published).catch(
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
