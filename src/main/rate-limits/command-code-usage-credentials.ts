import { createHmac, randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join, win32 as pathWin32 } from 'node:path'
import { parseWslUncPath } from '../../shared/wsl-paths'
import type { CommandCodeHomeResolution } from '../command-code/command-code-runtime-home'
import {
  createAuthFilesystemOperation,
  type SharedAuthFilesystemOperation
} from './auth-filesystem-operation'

export const COMMAND_CODE_API_KEY_ENV = 'COMMAND_CODE_API_KEY'
export const COMMAND_CODE_ENV_CREDENTIAL_SOURCE = `env:${COMMAND_CODE_API_KEY_ENV}`
export const COMMAND_CODE_AUTH_FILE_NAME = 'auth.json'

const CREDENTIALS_READ_TIMEOUT_MS = 5_000
// Why: per-process HMAC key so a leaked provenance can't be correlated with an API key.
const CREDENTIAL_IDENTITY_KEY = randomBytes(32)

export type CommandCodeUsageCredentials = {
  apiKey: string
  authProvenance: string
  source: string
}

export type CommandCodeUsageCredentialRead =
  | { status: 'missing' }
  | { status: 'error'; error: string }
  | { status: 'ok'; credentials: CommandCodeUsageCredentials }

function isUsableKey(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !/[\r\n]/.test(value)
}

function buildCredentials(apiKey: string, source: string): CommandCodeUsageCredentials {
  return {
    apiKey: apiKey.trim(),
    source,
    authProvenance: createHmac('sha256', CREDENTIAL_IDENTITY_KEY)
      .update(JSON.stringify(['command-code', apiKey.trim()]))
      .digest('hex')
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseAuthFile(value: unknown): string | null {
  if (!isRecord(value)) {
    return null
  }
  const apiKey = value.apiKey
  return isUsableKey(apiKey) ? apiKey : null
}

function isMissingPathError(error: unknown): boolean {
  if (!isRecord(error)) {
    return false
  }
  return error.code === 'ENOENT' || error.code === 'ENOTDIR'
}

function readErrorMessage(error: unknown): string {
  // Why: AbortSignal timeouts reject with a DOMException, not an Error.
  return isRecord(error) && typeof error.message === 'string'
    ? error.message
    : 'Unable to read Command Code credentials'
}

export function getCommandCodeAuthFilePath(commandCodeHome: string): string {
  // WSL homes arrive as `\\wsl.localhost\<distro>\...`, which only win32 join keeps intact.
  return parseWslUncPath(commandCodeHome)
    ? pathWin32.join(commandCodeHome, COMMAND_CODE_AUTH_FILE_NAME)
    : join(commandCodeHome, COMMAND_CODE_AUTH_FILE_NAME)
}

const credentialsReadByPath = new Map<
  string,
  SharedAuthFilesystemOperation<CommandCodeUsageCredentialRead>
>()

function getCredentialsRead(
  path: string
): SharedAuthFilesystemOperation<CommandCodeUsageCredentialRead> {
  const existing = credentialsReadByPath.get(path)
  if (existing) {
    return existing
  }
  // Why: aborting an fs promise does not cancel an already issued UNC request, so
  // share one raw read per path until it settles (mirrors kimi-fetcher's auth read).
  const read = createAuthFilesystemOperation(
    path,
    async (): Promise<CommandCodeUsageCredentialRead> => {
      let raw: string
      try {
        raw = await readFile(path, 'utf-8')
      } catch (error) {
        return isMissingPathError(error)
          ? { status: 'missing' }
          : { status: 'error', error: readErrorMessage(error) }
      }
      let apiKey: string | null
      try {
        apiKey = parseAuthFile(JSON.parse(raw))
      } catch {
        return { status: 'error', error: 'Command Code auth file is not valid JSON' }
      }
      if (!apiKey) {
        return { status: 'error', error: 'Command Code auth file has no usable API key' }
      }
      return { status: 'ok', credentials: buildCredentials(apiKey, path) }
    }
  )
  credentialsReadByPath.set(path, read)
  const clearRead = (): void => {
    if (credentialsReadByPath.get(path) === read) {
      credentialsReadByPath.delete(path)
    }
  }
  void read.result.then(clearRead, clearRead)
  return read
}

/**
 * Reads the CLI's own login (env override first on the host, then
 * `auth.json`). Orca never writes this file and the key never leaves main.
 */
export async function readCommandCodeUsageCredentials({
  home
}: {
  home: CommandCodeHomeResolution
}): Promise<CommandCodeUsageCredentialRead> {
  // Why: COMMAND_CODE_API_KEY describes the host process, never a distro's login.
  if (home.runtime === 'host') {
    const fromEnv = process.env[COMMAND_CODE_API_KEY_ENV]
    if (isUsableKey(fromEnv)) {
      return {
        status: 'ok',
        credentials: buildCredentials(fromEnv, COMMAND_CODE_ENV_CREDENTIAL_SOURCE)
      }
    }
  }
  if (!home.path) {
    return { status: 'missing' }
  }
  try {
    // Why: a stopped distro parks a UNC read for minutes; bound it so a WSL home
    // degrades to an error instead of stalling the poll cycle.
    return await getCredentialsRead(getCommandCodeAuthFilePath(home.path)).wait(
      AbortSignal.timeout(CREDENTIALS_READ_TIMEOUT_MS)
    )
  } catch (error) {
    return { status: 'error', error: readErrorMessage(error) }
  }
}
