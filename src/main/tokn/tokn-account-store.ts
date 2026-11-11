import { readFile, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createEncryptedApiKeyFileStore } from '../credentials/encrypted-api-key-file-store'
import { writeSecureJsonFile } from '../../shared/secure-storage/secure-file'
import type { ToknSyncErrorCode } from '../../shared/tokn-sync-status'

/** Everything about the connection except the token, so status reads never touch the keychain. */
export type ToknAccountRecord = {
  /** The tokn that issued the token; it is never sent to any other origin. */
  origin: string
  handle: string
  profileUrl: string | null
  lastSyncAt: number | null
  lastSyncError: ToknSyncErrorCode | null
  lastSyncErrorDetail: string | null
  lastSyncAccepted: number | null
  lastSyncRejected: number | null
}

const SYNC_ERROR_CODES: readonly ToknSyncErrorCode[] = [
  'tracking-off',
  'network',
  'rate-limited',
  'rejected',
  'server',
  'signed-out'
]

const accessTokenFile = createEncryptedApiKeyFileStore({
  fileName: 'tokn-access-token.enc',
  envelopePrefix: 'orca-tokn-access-token:v1:',
  providerLabel: 'tokn',
  logScope: 'tokn'
})

function accountRecordPath(): string {
  return join(homedir(), '.orca', 'tokn-account.json')
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function syncErrorCode(value: unknown): ToknSyncErrorCode | null {
  return SYNC_ERROR_CODES.find((code) => code === value) ?? null
}

/** Null when signed out, or signed in to a different tokn than `origin`. */
export async function loadToknAccountRecord(origin: string): Promise<ToknAccountRecord | null> {
  if (!accessTokenFile.has()) {
    return null
  }
  let value: unknown
  try {
    value = JSON.parse(await readFile(accountRecordPath(), 'utf8'))
  } catch {
    return null
  }
  if (!isRecordObject(value) || value.origin !== origin || typeof value.handle !== 'string') {
    return null
  }
  return {
    origin,
    handle: value.handle,
    profileUrl: nullableString(value.profileUrl),
    lastSyncAt: nullableNumber(value.lastSyncAt),
    lastSyncError: syncErrorCode(value.lastSyncError),
    lastSyncErrorDetail: nullableString(value.lastSyncErrorDetail),
    lastSyncAccepted: nullableNumber(value.lastSyncAccepted),
    lastSyncRejected: nullableNumber(value.lastSyncRejected)
  }
}

export function saveToknAccountRecord(record: ToknAccountRecord): void {
  writeSecureJsonFile(accountRecordPath(), record)
}

export function saveToknAccount(accessToken: string, record: ToknAccountRecord): void {
  accessTokenFile.save(accessToken)
  saveToknAccountRecord(record)
}

/** Decrypts the token; only a sync or disconnect should need it. */
export function readToknAccessToken(): string | null {
  try {
    return accessTokenFile.read()
  } catch (error) {
    console.warn('[tokn] Could not read the saved access token', error)
    return null
  }
}

export async function clearToknAccount(): Promise<void> {
  accessTokenFile.clear()
  await rm(accountRecordPath(), { force: true })
}
