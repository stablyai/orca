import { readFile, rm } from 'node:fs/promises'
import { getSecretStore, hasSecretStore } from '../../../../shared/secure-storage/secret-store'
import { writeSecureFile } from '../../../../shared/secure-storage/secure-file'
import type { CdpCookie } from '../browser-cdp-cookie'

const SNAPSHOT_FORMAT = 'orca-browser-session-cookies-v1'

type PersistedSnapshot = {
  format: typeof SNAPSHOT_FORMAT
  /** base64 sealed JSON of the CDP cookies. */
  cookies: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isCdpCookie(value: unknown): value is CdpCookie {
  return isRecord(value) && typeof value.name === 'string' && typeof value.value === 'string'
}

/** Missing, unreadable or unsealable files read as no saved cookies. */
export async function readSessionCookieSnapshot(filePath: string): Promise<CdpCookie[]> {
  try {
    const persisted: unknown = JSON.parse(await readFile(filePath, 'utf8'))
    if (
      !isRecord(persisted) ||
      persisted.format !== SNAPSHOT_FORMAT ||
      typeof persisted.cookies !== 'string'
    ) {
      return []
    }
    const cookies: unknown = JSON.parse(
      getSecretStore().decryptString(Buffer.from(persisted.cookies, 'base64'))
    )
    return Array.isArray(cookies) ? cookies.filter(isCdpCookie) : []
  } catch {
    return []
  }
}

export async function writeSessionCookieSnapshot(
  filePath: string,
  cookies: readonly CdpCookie[]
): Promise<void> {
  // Why remove when unsealable: session cookies never sit on disk in the clear, and a stale file would undo sign-outs.
  if (cookies.length === 0 || !hasSecretStore() || !getSecretStore().isEncryptionAvailable()) {
    await removeSessionCookieSnapshot(filePath)
    return
  }
  const persisted: PersistedSnapshot = {
    format: SNAPSHOT_FORMAT,
    cookies: getSecretStore().encryptString(JSON.stringify(cookies)).toString('base64')
  }
  writeSecureFile(filePath, JSON.stringify(persisted))
}

export async function removeSessionCookieSnapshot(filePath: string): Promise<void> {
  await rm(filePath, { force: true })
}
