import { readClaudeGlobalConfig } from './claude-global-config'
import { isRecord } from '../../../shared/agent-status/child-work/agent-status-child-work-value-guards'

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
  const responses = (await readClaudeGlobalConfig(env, platform))?.customApiKeyResponses
  const { approved, rejected } = isRecord(responses) ? responses : {}
  // Claude records answers by the trimmed key's last 20 characters.
  const suffix = apiKey.trim().slice(-20)
  const lists = (answers: unknown) => Array.isArray(answers) && answers.includes(suffix)
  if (!lists(approved) && lists(rejected)) {
    for (const name of keyNames) {
      delete env[name]
    }
  }
  return env
}
