import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolveClaudeGlobalConfigFile } from './claude-folder-trust-file'
import { isRecord } from '../../../shared/agent-status/child-work/agent-status-child-work-value-guards'

/** The global config a local Claude child launched with this env reads; null when missing or unreadable. */
export async function readClaudeGlobalConfig(
  env: Record<string, string>,
  platform: NodeJS.Platform = process.platform
): Promise<Record<string, unknown> | null> {
  const style = platform === 'win32' ? 'win32' : 'posix'
  const configFile = resolveClaudeGlobalConfigFile({
    env,
    homeDir: (style === 'win32' ? env.USERPROFILE : env.HOME) || homedir(),
    style,
    exists: existsSync
  })
  try {
    const parsed: unknown = JSON.parse(await readFile(configFile, 'utf8'))
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}
