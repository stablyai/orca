import { readFile } from 'node:fs/promises'
import {
  createAuthFilesystemOperation,
  type SharedAuthFilesystemOperation
} from './auth-filesystem-operation'
import {
  DEFAULT_KIMI_TOKEN_NAME,
  getKimiConfigPath,
  getKimiCredentialsPath,
  resolveKimiCredentialSlots
} from './kimi-credentials-slot'

const CREDENTIALS_READ_TIMEOUT_MS = 5_000

export type KimiCredentials = {
  access_token?: string
  expires_at?: number
}

export type CredentialsReadResult =
  | { status: 'missing' }
  | { status: 'error'; error: string }
  | { status: 'ok'; credentials: KimiCredentials; baseUrl: string | null }

type TextReadResult =
  | { status: 'missing' }
  | { status: 'error'; error: string }
  | { status: 'ok'; raw: string }

function parseCredentials(value: unknown): KimiCredentials | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const credentials: KimiCredentials = {}
  if ('access_token' in value && typeof value.access_token === 'string') {
    credentials.access_token = value.access_token
  }
  if ('expires_at' in value && typeof value.expires_at === 'number') {
    credentials.expires_at = value.expires_at
  }
  return credentials
}

const textReadByPath = new Map<string, SharedAuthFilesystemOperation<TextReadResult>>()

function isMissingPathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

function readErrorMessage(err: unknown): string {
  // Why: AbortSignal timeouts reject with a DOMException, not an Error.
  const message = (err as { message?: unknown } | null)?.message
  return typeof message === 'string' ? message : 'Unable to read Kimi credentials'
}

function getTextRead(path: string): SharedAuthFilesystemOperation<TextReadResult> {
  const existing = textReadByPath.get(path)
  if (existing) {
    return existing
  }
  // Why: aborting an fs promise does not cancel an already issued UNC request, so
  // share one raw read per path until it settles (mirrors codex-fetcher's auth read).
  const read = createAuthFilesystemOperation(path, async (): Promise<TextReadResult> => {
    try {
      return { status: 'ok', raw: await readFile(path, 'utf-8') }
    } catch (err) {
      return isMissingPathError(err)
        ? { status: 'missing' }
        : { status: 'error', error: readErrorMessage(err) }
    }
  })
  textReadByPath.set(path, read)
  const clearRead = (): void => {
    if (textReadByPath.get(path) === read) {
      textReadByPath.delete(path)
    }
  }
  void read.result.then(clearRead, clearRead)
  return read
}

async function readText(path: string, signal: AbortSignal): Promise<TextReadResult> {
  try {
    return await getTextRead(path).wait(signal)
  } catch (err) {
    return { status: 'error', error: readErrorMessage(err) }
  }
}

function parseCredentialsText(raw: string, baseUrl: string | null): CredentialsReadResult {
  try {
    const credentials = parseCredentials(JSON.parse(raw))
    return credentials
      ? { status: 'ok', credentials, baseUrl }
      : { status: 'error', error: 'Kimi credentials file is invalid' }
  } catch (err) {
    return { status: 'error', error: readErrorMessage(err) }
  }
}

export async function readKimiCredentials(kimiHome: string): Promise<CredentialsReadResult> {
  // Why: a stopped distro parks a UNC read for minutes; bound the whole lookup so
  // a WSL home degrades to an error instead of stalling the poll cycle.
  const signal = AbortSignal.timeout(CREDENTIALS_READ_TIMEOUT_MS)
  const config = await readText(getKimiConfigPath(kimiHome), signal)
  if (config.status === 'error' && signal.aborted) {
    return config
  }
  // An unreadable config only loses the scoped slot; the default slot still works.
  const slots = resolveKimiCredentialSlots(config.status === 'ok' ? config.raw : null)
  for (const slot of slots) {
    const credentials = await readText(getKimiCredentialsPath(kimiHome, slot.tokenName), signal)
    // Why: fall back only when the scoped file is missing. If it exists but is
    // unreadable, surface that error: the legacy file may be stale or belong to
    // another account, so silently using it would show the wrong usage.
    if (credentials.status === 'missing' && slot.tokenName !== DEFAULT_KIMI_TOKEN_NAME) {
      continue
    }
    return credentials.status === 'ok'
      ? parseCredentialsText(credentials.raw, slot.baseUrl)
      : credentials
  }
  return { status: 'missing' }
}
