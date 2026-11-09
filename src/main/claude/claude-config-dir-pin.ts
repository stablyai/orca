import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

// Strip inherited account pins so only the session record selects the Keychain identity.
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

export function defaultClaudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude')
}

function samePath(a: string, b: string, platform: NodeJS.Platform): boolean {
  const left = resolve(a)
  const right = resolve(b)
  return platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

// Pin only nondefault homes: even an explicit default changes the CLI's Keychain identity.
// Preserve the trimmed path's spelling; normalization is only for comparison.
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
