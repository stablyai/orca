import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolveClaudeGlobalConfigFile } from './claude-folder-trust-file'

async function readRejectedApiKeyIds(configFile: string): Promise<readonly unknown[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(configFile, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || !('customApiKeyResponses' in parsed)) {
      return []
    }
    const responses = parsed.customApiKeyResponses
    if (typeof responses !== 'object' || responses === null || !('rejected' in responses)) {
      return []
    }
    return Array.isArray(responses.rejected) ? responses.rejected : []
  } catch {
    return []
  }
}

/**
 * Non-interactive Claude always bills ANTHROPIC_API_KEY, while the TUI skips a key the user
 * rejected; drop only that key so chat follows the same login as the terminal.
 */
export async function withoutRejectedClaudeApiKey(
  env: Record<string, string>,
  platform: NodeJS.Platform = process.platform
): Promise<Record<string, string>> {
  const keyNames = Object.keys(env).filter((name) =>
    platform === 'win32' ? name.toUpperCase() === 'ANTHROPIC_API_KEY' : name === 'ANTHROPIC_API_KEY'
  )
  const apiKey = keyNames.length > 0 ? env[keyNames[0]] : undefined
  if (!apiKey) {
    return env
  }
  const style = platform === 'win32' ? 'win32' : 'posix'
  const configFile = resolveClaudeGlobalConfigFile({
    env,
    homeDir: (style === 'win32' ? env.USERPROFILE : env.HOME) || homedir(),
    style,
    exists: existsSync
  })
  const rejected = await readRejectedApiKeyIds(configFile)
  // Claude records answers by the trimmed key's last 20 characters.
  if (rejected.includes(apiKey.trim().slice(-20))) {
    for (const name of keyNames) {
      delete env[name]
    }
  }
  return env
}
