import { join } from 'node:path'

/** Claude's machine-wide managed-settings.json, which wins over the user's settings.json. */
export function claudeManagedSettingsFile(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string {
  const folder =
    platform === 'darwin'
      ? '/Library/Application Support/ClaudeCode'
      : platform === 'win32'
        ? join(env.PROGRAMFILES || 'C:\\Program Files', 'ClaudeCode')
        : '/etc/claude-code'
  return join(folder, 'managed-settings.json')
}
