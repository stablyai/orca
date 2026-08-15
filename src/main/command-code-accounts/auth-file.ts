import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const MAX_AUTH_FILE_BYTES = 1024 * 1024
const MAX_API_KEY_LENGTH = 16_384
const MAX_USER_NAME_LENGTH = 256

export type CommandCodeAuth = {
  apiKey: string
  userName: string | null
}

function parseOptionalUserName(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const normalized = value.trim()
  if (
    !normalized ||
    normalized.length > MAX_USER_NAME_LENGTH ||
    normalized.includes('\u0000') ||
    /[\r\n]/.test(normalized)
  ) {
    return null
  }
  return normalized
}

export function readCommandCodeAuthFile(authPath: string): CommandCodeAuth {
  if (!existsSync(authPath)) {
    throw new Error('Command Code auth.json was not found.')
  }
  const info = lstatSync(authPath)
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error('Command Code auth.json must be a regular file, not a symbolic link.')
  }
  if (info.size <= 0) {
    throw new Error('Command Code auth.json is empty.')
  }
  if (info.size > MAX_AUTH_FILE_BYTES) {
    throw new Error('Command Code auth.json exceeds the 1 MB safety limit.')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(authPath, 'utf-8'))
  } catch {
    throw new Error('Command Code auth.json is not valid JSON.')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Command Code auth.json must contain an object.')
  }
  const apiKey = (parsed as { apiKey?: unknown }).apiKey
  if (
    typeof apiKey !== 'string' ||
    !apiKey.trim() ||
    apiKey.length > MAX_API_KEY_LENGTH ||
    apiKey.includes('\u0000') ||
    /[\r\n]/.test(apiKey)
  ) {
    throw new Error('Command Code auth.json does not contain a valid API key.')
  }
  return {
    apiKey: apiKey.trim(),
    userName: parseOptionalUserName((parsed as { userName?: unknown }).userName)
  }
}

export function copyCommandCodeAuth(sourceHome: string, destinationRoot: string): CommandCodeAuth {
  const resolvedHome = resolve(sourceHome)
  if (!existsSync(resolvedHome)) {
    throw new Error('Selected Command Code home does not exist.')
  }
  const homeInfo = lstatSync(resolvedHome)
  if (!homeInfo.isDirectory() || homeInfo.isSymbolicLink()) {
    throw new Error('Selected Command Code home must be a directory, not a symbolic link.')
  }
  const sourceAuthPath = join(resolvedHome, 'auth.json')
  const auth = readCommandCodeAuthFile(sourceAuthPath)
  mkdirSync(destinationRoot, { recursive: true, mode: 0o700 })
  const destinationAuthPath = join(destinationRoot, 'auth.json')
  copyFileSync(sourceAuthPath, destinationAuthPath)
  if (process.platform !== 'win32') {
    chmodSync(destinationRoot, 0o700)
    chmodSync(destinationAuthPath, 0o600)
  }
  return auth
}
