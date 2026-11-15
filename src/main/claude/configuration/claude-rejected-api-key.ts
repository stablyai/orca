import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolveClaudeGlobalConfigFile } from './claude-folder-trust-file'

type ClaudeApiKeyResponses = { approved: readonly unknown[]; rejected: readonly unknown[] }

async function readApiKeyResponses(configFile: string): Promise<ClaudeApiKeyResponses> {
  const empty = { approved: [], rejected: [] }
  try {
    const parsed: unknown = JSON.parse(await readFile(configFile, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || !('customApiKeyResponses' in parsed)) {
      return empty
    }
    const responses = parsed.customApiKeyResponses
    if (typeof responses !== 'object' || responses === null) {
      return empty
    }
    return {
      approved:
        'approved' in responses && Array.isArray(responses.approved) ? responses.approved : [],
      rejected:
        'rejected' in responses && Array.isArray(responses.rejected) ? responses.rejected : []
    }
  } catch {
    return empty
  }
}

/** Non-interactive Claude bills even rejected API keys; omit them to match the TUI’s login. */
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
  const responses = await readApiKeyResponses(configFile)
  // Claude records answers by the trimmed key's last 20 characters.
  const suffix = apiKey.trim().slice(-20)
  if (!responses.approved.includes(suffix) && responses.rejected.includes(suffix)) {
    for (const name of keyNames) {
      delete env[name]
    }
  }
  return env
}
