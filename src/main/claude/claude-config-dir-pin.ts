import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * The record owns a structured session's Claude home and `claudeConfigDirEnvPatch` is its sole
 * emitter, so every base the child inherits (the shell snapshot, Orca's own process env) must
 * arrive without one: a CLAUDE_CONFIG_DIR left there would flip the pin's comparison and force
 * an explicit pin to the CLI default, which moves the CLI off its default Keychain item.
 */
export function withoutInheritedClaudeConfigDir(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform
): Record<string, string> {
  const next: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (
      value !== undefined &&
      (platform === 'win32' ? key.toUpperCase() : key) !== 'CLAUDE_CONFIG_DIR'
    ) {
      next[key] = value
    }
  }
  return next
}

/** The config dir the Claude CLI resolves for itself when nothing pins one. */
export function defaultClaudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude')
}

function samePath(a: string, b: string, platform: NodeJS.Platform): boolean {
  const left = resolve(a)
  const right = resolve(b)
  return platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

/**
 * An explicit CLAUDE_CONFIG_DIR moves the Claude CLI off the default Keychain item onto
 * one derived from the pinned path, so a claude.ai OAuth login stops working even when
 * the pin names the CLI's own default. Pin only a home the CLI would not find on its
 * own — the same rule the legacy PTY path applies via `ClaudeRuntimePathResolver`.
 *
 * The pinned value is the account home verbatim: the CLI keys its credential lookup on
 * the literal string, so re-spelling an equivalent path (absolute vs `~`, trailing
 * separator) selects a different identity. Normalization here is for the equality test
 * only and must never reach the env.
 */
export function claudeConfigDirEnvPatch(
  accountHome: string,
  options: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {}
): { CLAUDE_CONFIG_DIR?: string } {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const resolved = accountHome.trim()
  if (!resolved || samePath(resolved, defaultClaudeConfigDir(env), platform)) {
    return {}
  }
  return { CLAUDE_CONFIG_DIR: resolved }
}
