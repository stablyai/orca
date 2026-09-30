import { lstat } from 'node:fs/promises'
import { readNodeFileWithinLimit } from '../../shared/node-bounded-file-reader'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type CommandCodeCredentials = {
  apiKey: string
  source: 'environment' | 'cli-login'
}

export function getCommandCodeAuthPath(): string {
  return join(homedir(), '.commandcode', 'auth.json')
}

function credentialsFrom(
  value: unknown,
  source: CommandCodeCredentials['source']
): CommandCodeCredentials | null {
  if (typeof value !== 'string' || !value.trim() || /[\r\n]/.test(value)) {
    return null
  }
  const apiKey = value.trim()
  return {
    apiKey,
    source
  }
}

/** Matches Command Code's environment override before its saved production login. */
export async function readCommandCodeCredentials(
  authPath: string,
  environment: NodeJS.ProcessEnv = process.env
): Promise<CommandCodeCredentials | null> {
  const override = environment.COMMAND_CODE_API_KEY
  if (override !== undefined && override !== '') {
    // An invalid override must not silently select a different saved account.
    return credentialsFrom(override, 'environment')
  }
  try {
    if (!(await lstat(authPath)).isFile()) {
      return null
    }
    const { buffer } = await readNodeFileWithinLimit(authPath, 1_000_000)
    const parsed: unknown = JSON.parse(buffer.toString('utf8'))
    if (!parsed || typeof parsed !== 'object' || !('apiKey' in parsed)) {
      return null
    }
    return credentialsFrom(parsed.apiKey, 'cli-login')
  } catch {
    return null
  }
}
