import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

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
 * A project-group binding to `~/.claude` therefore emits nothing and is a no-op by design.
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

/**
 * Whether pinning this home actually changes which credentials the child reads.
 *
 * The one place the "custom home" question is decided, so the pin and every gate that keys off a
 * custom home cannot drift: a binding the patch above declines to emit is a no-op, and a no-op
 * binding must not switch off a gate.
 */
export function isCustomClaudeConfigDir(
  accountHome: string,
  options: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {}
): boolean {
  return claudeConfigDirEnvPatch(accountHome, options).CLAUDE_CONFIG_DIR !== undefined
}
