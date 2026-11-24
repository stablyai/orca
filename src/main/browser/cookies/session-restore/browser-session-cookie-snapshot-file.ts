import { app } from 'electron'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { isBrowserRoutePartition } from '../../routing/partitions/browser-route-identity'
import { getSecretStore, hasSecretStore } from '../../../../shared/secure-storage/secret-store'
import { writeSecureFile } from '../../../../shared/secure-storage/secure-file'
import type { CdpCookie } from '../browser-cdp-cookie'

const SNAPSHOT_FORMAT = 'orca-browser-session-cookies-v1'
const SNAPSHOT_DIRECTORY = 'browser-session-cookies'
const ROUTE_SNAPSHOT_DIRECTORY = 'route-partitions'

let profileDirectory: string | null = null

export function configureBrowserSessionCookieSnapshots(directory: string): void {
  profileDirectory = directory
}

function snapshotDirectory(): string {
  return join(profileDirectory ?? app.getPath('userData'), SNAPSHOT_DIRECTORY)
}

export function snapshotPath(profileId: string): string {
  return join(snapshotDirectory(), `${encodeURIComponent(profileId)}.json`)
}

// Why its own folder: a profile id can never name a route partition's file, or the reverse.
export function routeSnapshotPath(partition: string): string {
  if (!isBrowserRoutePartition(partition)) {
    throw new Error('browser_route_partition_identity_invalid')
  }
  return join(
    snapshotDirectory(),
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

/**
 * A missing file reads as no saved cookies, and so does one that isn't JSON: no key or later Orca
 * can read those bytes, so live cookies may replace them. null means a file that might read on a
 * later launch (an I/O error, a newer format, a refused decrypt): it must be kept.
 */
export async function readSessionCookieSnapshot(filePath: string): Promise<CdpCookie[] | null> {
  let raw: string
  try {
    raw = await readFile(filePath, 'utf8')
  } catch (error) {
    return isRecord(error) && error.code === 'ENOENT' ? [] : null
  }
  let persisted: unknown
  try {
    persisted = JSON.parse(raw)
  } catch {
    return []
  }
  try {
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

export function canSealSessionCookies(): boolean {
  return hasSecretStore() && getSecretStore().isEncryptionAvailable()
}

/** An empty set removes the file. */
export async function writeSessionCookieSnapshot(
  filePath: string,
  cookies: readonly CdpCookie[]
): Promise<void> {
  if (cookies.length === 0) {
    await removeSessionCookieSnapshot(filePath)
    return
  }
  // Session cookies never sit on disk in the clear. Why fail rather than remove the file: it may
  // hold other sites' sign-ins, which an unrelated write must not drop.
  if (!canSealSessionCookies()) {
    throw new Error('browser_session_cookies_unsealable')
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
