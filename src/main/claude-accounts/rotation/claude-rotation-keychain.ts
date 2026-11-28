import { createHash } from 'node:crypto'
import {
  deleteKeychainPassword,
  keychainPasswordFitsInteractiveWrite,
  readKeychainPassword,
  writeKeychainPassword
} from '../../macos-keychain/generic-password'
import { getKeychainUser } from '../runtime-auth/keychain'

export type ClaudeKeychainSlot = Record<string, unknown>
export type ClaudeAiOauth = Record<string, unknown>

/** Keychain access the rotation needs; tests pass an in-memory store. */
export type RotationSlotStore = {
  /** Null when the slot does not exist; throws when it cannot be read or parsed. */
  read(service: string): Promise<ClaudeKeychainSlot | null>
  /** False unless the slot reads back exactly as written. */
  write(service: string, slot: ClaudeKeychainSlot): Promise<boolean>
  fits(service: string, slot: ClaudeKeychainSlot): boolean
  remove(service: string): Promise<void>
}

export const ROTATION_JOURNAL_SERVICE_A = 'Orca Claude rotation journal-a'
export const ROTATION_JOURNAL_SERVICE_B = 'Orca Claude rotation journal-b'

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** security prints binary-looking values as hex, so try plain JSON first. */
export function parseKeychainSlot(raw: string): ClaudeKeychainSlot | null {
  const texts = [raw]
  if (/^(?:[0-9a-fA-F]{2})+$/.test(raw)) {
    texts.push(Buffer.from(raw, 'hex').toString('utf8'))
  }
  for (const text of texts) {
    try {
      const value: unknown = JSON.parse(text)
      if (isRecord(value)) {
        return value
      }
    } catch {
      // Try the next spelling.
    }
  }
  return null
}

export function encodeKeychainSlot(slot: ClaudeKeychainSlot): string {
  return JSON.stringify(slot)
}

export function oauthOf(slot: ClaudeKeychainSlot | null | undefined): ClaudeAiOauth {
  const oauth = slot?.claudeAiOauth
  return isRecord(oauth) ? oauth : {}
}

export function withOauth(
  slot: ClaudeKeychainSlot | null,
  oauth: ClaudeAiOauth
): ClaudeKeychainSlot {
  return { ...slot, claudeAiOauth: oauth }
}

/** Stored and compared instead of tokens; matches the external script's hashes. */
export function tokenHash(value: unknown): string {
  const text = typeof value === 'string' ? value : ''
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12)
}

export function accessTokenOf(oauth: ClaudeAiOauth): string | null {
  const token = oauth.accessToken
  return typeof token === 'string' && token ? token : null
}

export function hasRefreshToken(oauth: ClaudeAiOauth): boolean {
  return typeof oauth.refreshToken === 'string' && oauth.refreshToken !== ''
}

/** A token within a minute of expiry is left for Claude Code to refresh. */
export function accessUsable(oauth: ClaudeAiOauth, now: number): boolean {
  const expiresAt = oauth.expiresAt
  return accessTokenOf(oauth) !== null && typeof expiresAt === 'number' && expiresAt > now + 60_000
}

export function refreshExpired(oauth: ClaudeAiOauth, now: number): boolean {
  const expiresAt = oauth.refreshTokenExpiresAt
  return typeof expiresAt === 'number' && expiresAt < now
}

export function createMacKeychainSlotStore(): RotationSlotStore {
  const account = getKeychainUser()
  const read = async (service: string): Promise<ClaudeKeychainSlot | null> => {
    let raw: string | null
    try {
      raw = await readKeychainPassword(service, account)
    } catch {
      throw new Error(`Could not read macOS Keychain item ${service}.`)
    }
    if (raw === null) {
      return null
    }
    const slot = parseKeychainSlot(raw)
    if (!slot) {
      throw new Error(`macOS Keychain item ${service} is not in the expected format.`)
    }
    return slot
  }
  return {
    read,
    fits: (service, slot) =>
      keychainPasswordFitsInteractiveWrite(service, account, encodeKeychainSlot(slot)),
    async write(service, slot) {
      const text = encodeKeychainSlot(slot)
      try {
        await writeKeychainPassword(service, account, text)
        const back = await read(service)
        return back !== null && encodeKeychainSlot(back) === text
      } catch {
        return false
      }
    },
    remove: (service) => deleteKeychainPassword(service, account).catch(() => undefined)
  }
}
