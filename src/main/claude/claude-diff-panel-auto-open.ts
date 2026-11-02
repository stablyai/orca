import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolveClaudeGlobalConfigFile } from './claude-folder-trust-file'
import { claudeVersionReaches } from './claude-hook-event-versions'

/** The Claude Code release whose `/diff` panel opens by itself beside the transcript. */
export const CLAUDE_DIFF_PANEL_FIRST_VERSION = '2.1.260'

// Why two widths: the panel opens unasked from 144 columns, or from 110 once the user opened it.
const AUTO_OPEN_MIN_COLUMNS = 144
const REOPEN_MIN_COLUMNS = 110

// Why the hash: Claude names a built-in plugin's store file after the first 12 hex of sha256(id).
const DIFF_PANEL_PLUGIN_ID = 'cc-plugin-diff@builtin'

export function claudeDiffPanelStorePath(configDir: string): string {
  const hash = createHash('sha256').update(DIFF_PANEL_PLUGIN_ID).digest('hex').slice(0, 12)
  return join(configDir, 'plugins', 'store', `cc-plugin-diff_builtin-${hash}.json`)
}

async function readJsonObject(path: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a parsed non-array object is a string-keyed record.
        (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

export type ClaudeDiffPanelAutoOpenInput = {
  /** The pane's explicit CLAUDE_CONFIG_DIR; undefined when Claude runs on its default. */
  configDirEnv: string | undefined
  /** The pane's Claude CLI version; null when unknown, which answers false. */
  version: string | null
  /** The pane's columns; null when unknown, which skips the width gate. */
  cols: number | null
  home?: string
  platform?: NodeJS.Platform
}

/** The user's saved panel choice; undefined when Claude has never recorded one. */
export async function readClaudeDiffPanelPreference(
  input: Pick<ClaudeDiffPanelAutoOpenInput, 'configDirEnv' | 'home' | 'platform'>
): Promise<boolean | undefined> {
  const home = input.home ?? homedir()
  const configDir = input.configDirEnv ?? join(home, '.claude')
  const store = await readJsonObject(claudeDiffPanelStorePath(configDir))
  // Why the fallback: releases before the plugin pane kept the choice in the global config,
  // and the pane copies that value into its store only when it has none of its own.
  const globalConfig = resolveClaudeGlobalConfigFile({
    env: {
      CLAUDE_CONFIG_DIR: input.configDirEnv,
      CLAUDE_CODE_CUSTOM_OAUTH_URL: process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL
    },
    homeDir: home,
    style: (input.platform ?? process.platform) === 'win32' ? 'win32' : 'posix',
    exists: existsSync
  })
  return asBoolean(store?.open) ?? asBoolean((await readJsonObject(globalConfig))?.diffSidebarOpen)
}

/** Whether Claude in this pane may open its diff panel unasked, judged from its saved config. */
export async function claudeDiffPanelMayAutoOpen(
  input: ClaudeDiffPanelAutoOpenInput
): Promise<boolean> {
  if (!claudeVersionReaches(input.version, CLAUDE_DIFF_PANEL_FIRST_VERSION)) {
    return false
  }
  const configDir = input.configDirEnv ?? join(input.home ?? homedir(), '.claude')
  const settings = await readJsonObject(join(configDir, 'settings.json'))
  // Why: the panel exists only in the fullscreen renderer, which this setting opts out of.
  if (settings?.tui === 'default') {
    return false
  }
  const preference = await readClaudeDiffPanelPreference(input)
  if (preference === false) {
    return false
  }
  const minColumns = preference === true ? REOPEN_MIN_COLUMNS : AUTO_OPEN_MIN_COLUMNS
  return input.cols === null || input.cols >= minColumns
}
