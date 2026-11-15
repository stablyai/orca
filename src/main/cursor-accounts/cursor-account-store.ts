import { existsSync, lstatSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { getSecretStore } from '../../shared/secret-store'
import { writeCredentialFileAtomic } from '../credentials/integration-credential-file'
import type { CursorSavedAccount } from '../../shared/cursor-account-types'
import { parseCursorSnapshot } from './cursor-native-credential'

export type StoredCursorAccount = CursorSavedAccount & { credentials: string }
export type CursorAccountVault = {
  accounts: StoredCursorAccount[]
  selectedAccountId: string | null
}
export type CursorAccountStore = {
  read(): CursorAccountVault
  write(vault: CursorAccountVault): void
}

const MAX_VAULT_BYTES = 1024 * 1024

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function isAccount(value: unknown): value is StoredCursorAccount {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    isNullableString(value.email) &&
    isNullableString(value.displayName) &&
    typeof value.subject === 'string' &&
    value.subject.length > 0 &&
    typeof value.createdAt === 'number' &&
    typeof value.updatedAt === 'number' &&
    typeof value.credentials === 'string'
  )
}

function requireProtection(): void {
  const secrets = getSecretStore()
  if (!secrets.isEncryptionAvailable() || secrets.describeProtectionGap() !== null) {
    throw new Error('Protected secret storage is unavailable; Cursor accounts were not changed.')
  }
}

function parseVault(raw: Buffer): CursorAccountVault {
  const value: unknown = JSON.parse(getSecretStore().decryptString(raw))
  if (
    !isRecord(value) ||
    !Array.isArray(value.accounts) ||
    !value.accounts.every(isAccount) ||
    !isNullableString(value.selectedAccountId)
  ) {
    throw new Error('invalid vault')
  }
  const ids = new Set(value.accounts.map((account) => account.id))
  if (
    ids.size !== value.accounts.length ||
    (value.selectedAccountId !== null && !ids.has(value.selectedAccountId))
  ) {
    throw new Error('invalid selection')
  }
  for (const account of value.accounts) {
    if (parseCursorSnapshot(account.credentials).subject !== account.subject) {
      throw new Error('inconsistent identity')
    }
  }
  return { accounts: value.accounts, selectedAccountId: value.selectedAccountId }
}

export function createEncryptedCursorAccountStore(path: string): CursorAccountStore {
  return {
    read() {
      if (!existsSync(path)) {
        return { accounts: [], selectedAccountId: null }
      }
      requireProtection()
      try {
        const stat = lstatSync(path)
        if (!stat.isFile() || stat.size > MAX_VAULT_BYTES || (stat.mode & 0o077) !== 0) {
          throw new Error('unsafe vault')
        }
        return parseVault(readFileSync(path))
      } catch {
        throw new Error(
          'Cursor account snapshots could not be read; the existing vault was preserved.'
        )
      }
    },
    write(vault) {
      requireProtection()
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      try {
        const encrypted = getSecretStore().encryptString(JSON.stringify(vault))
        if (encrypted.length > MAX_VAULT_BYTES) {
          throw new Error('vault exceeds readable size')
        }
        writeCredentialFileAtomic(path, encrypted, undefined, true)
        if ((statSync(path).mode & 0o077) !== 0) {
          throw new Error('unsafe permissions')
        }
      } catch {
        throw new Error('Cursor account snapshots could not be saved.')
      }
    }
  }
}
