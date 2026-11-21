import { app } from 'electron'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { isBrowserRoutePartition } from '../../routing/partitions/browser-route-identity'
import { getSecretStore, hasSecretStore } from '../../../../shared/secure-storage/secret-store'
import { writeSecureFile } from '../../../../shared/secure-storage/secure-file'
import type { CdpCookie } from '../browser-cdp-cookie'
import { usesMockKeychain } from '../../../startup/chromium-policy/configure-dev-keychain'

const SNAPSHOT_FORMAT = 'orca-browser-session-cookies-v1'
const SNAPSHOT_DIRECTORY = 'browser-session-cookies'
const ROUTE_SNAPSHOT_DIRECTORY = 'route-partitions'

let profileDirectory: string | null = null

export function configureBrowserSessionCookieSnapshots(directory: string): void {
  profileDirectory = directory
}

function snapshotDirectory(mockKeychain: boolean): string {
  return join(
    profileDirectory ?? app.getPath('userData'),
    mockKeychain ? `${SNAPSHOT_DIRECTORY}-mock-keychain` : SNAPSHOT_DIRECTORY
  )
}

export function snapshotPath(profileId: string, mockKeychain = usesMockKeychain()): string {
  return join(snapshotDirectory(mockKeychain), `${encodeURIComponent(profileId)}.json`)
}

// Why its own folder: a profile id can never name a route partition's file, or the reverse.
export function routeSnapshotPath(partition: string, mockKeychain = usesMockKeychain()): string {
  if (!isBrowserRoutePartition(partition)) {
    throw new Error('browser_route_partition_identity_invalid')
  }
  return join(
    snapshotDirectory(mockKeychain),
    ROUTE_SNAPSHOT_DIRECTORY,
    `${partition.slice('persist:'.length)}.json`
  )
}

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

/** A missing file reads as no saved cookies; null means a file is there but could not be read. */
export async function readSessionCookieSnapshot(filePath: string): Promise<CdpCookie[] | null> {
  let raw: string
  try {
    raw = await readFile(filePath, 'utf8')
  } catch (error) {
    return isRecord(error) && error.code === 'ENOENT' ? [] : null
  }
  try {
    const persisted: unknown = JSON.parse(raw)
    if (
      !isRecord(persisted) ||
      persisted.format !== SNAPSHOT_FORMAT ||
      typeof persisted.cookies !== 'string'
    ) {
      return null
    }
    const cookies: unknown = JSON.parse(
      getSecretStore().decryptString(Buffer.from(persisted.cookies, 'base64'))
    )
    return Array.isArray(cookies) ? cookies.filter(isCdpCookie) : null
  } catch {
    return null
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
