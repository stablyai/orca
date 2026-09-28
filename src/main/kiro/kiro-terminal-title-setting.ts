import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '../../shared/child-process/run-process'
import { resolveCliCommand } from '../../shared/node-cli-command-resolution'

export const KIRO_TERMINAL_TITLE_SETTING = 'chat.terminalTitle'

/** The write is a local CLI call that only rewrites one key; it should never outlive a launch. */
const SETTINGS_WRITE_TIMEOUT_MS = 15_000

/** Where `kiro-cli settings` persists user-wide preferences. */
export function getKiroCliSettingsPath(): string {
  return join(homedir(), '.kiro', 'settings', 'cli.json')
}

export type KiroTerminalTitleResult = 'enabled' | 'already-set' | 'failed'

export type EnableKiroTerminalTitleOptions = {
  settingsPath?: string
  program?: string
  /** Injectable for tests; defaults to the real process runner. */
  run?: typeof runProcess
}

/**
 * Reads the key Orca is about to set. Returns the parsed settings object, or
 * null when the file exists in a shape that is the user's to own, not ours.
 */
function readKiroSettings(settingsPath: string): Record<string, unknown> | null {
  try {
    if (!existsSync(settingsPath)) {
      return {}
    }
    const parsed: unknown = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return null
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the three checks above rule out every non-record JSON value.
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

/**
 * Turn on Kiro's OSC title.
 *
 * Why Orca writes this: `chat.terminalTitle` defaults to false, and that title
 * (`kiro: <session>`) is the only thing Kiro emits that identifies the pane as
 * its own — without it a Kiro pane is an anonymous terminal in the sidebar.
 * Kiro's built-in default agent has no config file to attach status hooks to,
 * so the title is the whole identity signal, not a nicety.
 *
 * Narrow on purpose: one key, only when unset, so a user who turns it back off
 * is not overridden on next launch. The write goes through `kiro-cli settings`
 * rather than a whole-file rewrite, because another Kiro session can persist a
 * model or effort change between Orca's read and its write and a full-file
 * write would erase it.
 */
export async function enableKiroTerminalTitle(
  options: EnableKiroTerminalTitleOptions = {}
): Promise<KiroTerminalTitleResult> {
  const settings = readKiroSettings(options.settingsPath ?? getKiroCliSettingsPath())
  if (!settings) {
    return 'failed'
  }
  if (KIRO_TERMINAL_TITLE_SETTING in settings) {
    return 'already-set'
  }
  const program = options.program ?? resolveCliCommand('kiro-cli')
  try {
    const result = await (options.run ?? runProcess)({
      program,
      args: ['settings', KIRO_TERMINAL_TITLE_SETTING, 'true'],
      timeoutMs: SETTINGS_WRITE_TIMEOUT_MS
    })
    return result.code === 0 && !result.timedOut ? 'enabled' : 'failed'
  } catch {
    // runProcess rejects only when the CLI could not be started at all.
    return 'failed'
  }
}
