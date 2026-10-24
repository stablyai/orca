import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolveClaudeGlobalConfigFile } from './claude-folder-trust-file'
import { claudeVersionReaches } from './claude-hook-event-versions'

export const CLAUDE_DIFF_PANEL_FIRST_VERSION = '2.1.260'

// Claude uses a lower width threshold after the user has opened the panel.
const AUTO_OPEN_MIN_COLUMNS = 144
const REOPEN_MIN_COLUMNS = 110

// Claude keys built-in plugin stores by the first 12 SHA-256 hex digits.
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
  configDirEnv: string | undefined
  version: string | null
  /** Unknown width skips the width gate. */
  cols: number | null
  home?: string
  platform?: NodeJS.Platform
}

export async function readClaudeDiffPanelPreference(
  input: Pick<ClaudeDiffPanelAutoOpenInput, 'configDirEnv' | 'home' | 'platform'>
): Promise<boolean | undefined> {
  const home = input.home ?? homedir()
  const configDir = input.configDirEnv ?? join(home, '.claude')
  const store = await readJsonObject(claudeDiffPanelStorePath(configDir))
  // Older releases saved the preference globally; the plugin migrates it only without a store value.
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

export async function claudeDiffPanelMayAutoOpen(
  input: ClaudeDiffPanelAutoOpenInput
): Promise<boolean> {
  if (!claudeVersionReaches(input.version, CLAUDE_DIFF_PANEL_FIRST_VERSION)) {
    return false
  }
  const configDir = input.configDirEnv ?? join(input.home ?? homedir(), '.claude')
  const settings = await readJsonObject(join(configDir, 'settings.json'))
  // The diff panel requires Claude's fullscreen renderer.
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
