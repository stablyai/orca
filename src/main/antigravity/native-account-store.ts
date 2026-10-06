import { lstat, readFile } from 'node:fs/promises'
import { restrictWindowsPath } from '../../shared/secure-path-windows-acl'
import { writeProtectedFileAtomic } from '../../shared/secure-file'
import {
  remainingAccountOperationMs,
  withAntigravityAccountOperation,
  type AntigravityAccountOperation
} from './native-account-operation'
import type { ResolvedAntigravityWslTarget } from './native-wsl-account-target'
import { existsSync, lstatSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { getSecretStore } from '../../shared/secret-store'
import { writeCredentialFileAtomic } from '../integration-credential-file'
import type { AntigravityAccountSummary } from '../../shared/antigravity-account-types'
import { parseAntigravityNativeCredential } from './native-credential-codec'

export type StoredAntigravityAccount = AntigravityAccountSummary & { credentials: string }
export type AntigravityAccountVault = {
  accounts: StoredAntigravityAccount[]
  selectedAccountId: string | null
}
export type AntigravityAccountStore = {
  read(
    operation?: AntigravityAccountOperation
  ): AntigravityAccountVault | Promise<AntigravityAccountVault>
  write(
    vault: AntigravityAccountVault,
    operation?: AntigravityAccountOperation
  ): void | Promise<void>
}

const MAX_VAULT_BYTES = 4 * 1024 * 1024

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isAccount(value: unknown): value is StoredAntigravityAccount {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    (value.email === null || typeof value.email === 'string') &&
    (value.subject === null || typeof value.subject === 'string') &&
    typeof value.authMethod === 'string' &&
    typeof value.createdAt === 'number' &&
    typeof value.updatedAt === 'number' &&
    typeof value.credentials === 'string'
  )
}

function requireProtection(): void {
  const secrets = getSecretStore()
  if (!secrets.isEncryptionAvailable() || secrets.describeProtectionGap() !== null) {
    throw new Error(
      'Protected secret storage is unavailable; Antigravity accounts were not changed.'
    )
  }
}

type SynchronousAccountStore = {
  read(operation?: AntigravityAccountOperation): AntigravityAccountVault
  write(vault: AntigravityAccountVault, operation?: AntigravityAccountOperation): void
}
function scopeFor(authority: ResolvedAntigravityWslTarget) {
  return {
    version: 1,
    runtime: 'wsl',
    distro: authority.distro.toLowerCase(),
    uid: authority.uid,
    home: authority.canonicalHome
  }
}
function parseVault(
  bytes: Buffer,
  authority?: ResolvedAntigravityWslTarget
): AntigravityAccountVault {
  const value: unknown = JSON.parse(getSecretStore().decryptString(bytes))
  if (
    !isRecord(value) ||
    !Array.isArray(value.accounts) ||
    !value.accounts.every(isAccount) ||
    (value.selectedAccountId !== null && typeof value.selectedAccountId !== 'string') ||
    (authority && JSON.stringify(value.scope) !== JSON.stringify(scopeFor(authority)))
  ) {
    throw new Error('invalid vault scope or content')
  }
  const ids = new Set(value.accounts.map((account) => account.id))
  if (
    ids.size !== value.accounts.length ||
    (value.selectedAccountId !== null && !ids.has(value.selectedAccountId))
  ) {
    throw new Error('invalid selection')
  }
  for (const account of value.accounts) {
    const credential = parseAntigravityNativeCredential(account.credentials)
    if (
      credential.authMethod !== account.authMethod ||
      credential.identity?.subject !== account.subject
    ) {
      throw new Error('inconsistent identity')
    }
  }
  return { accounts: value.accounts, selectedAccountId: value.selectedAccountId }
}
function encryptedVault(
  vault: AntigravityAccountVault,
  authority?: ResolvedAntigravityWslTarget
): Buffer {
  requireProtection()
  const encrypted = getSecretStore().encryptString(
    JSON.stringify(authority ? { ...vault, scope: scopeFor(authority) } : vault)
  )
  if (encrypted.length > MAX_VAULT_BYTES) {
    throw new Error('vault exceeds readable size')
  }
  return encrypted
}
const READ_ERROR =
  'Antigravity account snapshots could not be read; the existing vault was preserved.'
function checkVaultStat(stat: { isFile(): boolean; size: number; mode: number }): void {
  if (
    !stat.isFile() ||
    stat.size > MAX_VAULT_BYTES ||
    (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)
  ) {
    throw new Error('unsafe vault')
  }
}
export function createEncryptedAntigravityAccountStore(path: string): SynchronousAccountStore
export function createEncryptedAntigravityAccountStore(
  path: string,
  options: { authority: ResolvedAntigravityWslTarget }
): AntigravityAccountStore
export function createEncryptedAntigravityAccountStore(
  path: string,
  options?: { authority: ResolvedAntigravityWslTarget }
): AntigravityAccountStore {
  if (options) {
    const authority = options.authority
    return {
      read(operation) {
        const run = async (
          context: AntigravityAccountOperation
        ): Promise<AntigravityAccountVault> => {
          remainingAccountOperationMs(context)
          if (!existsSync(path)) {
            return { accounts: [], selectedAccountId: null }
          }
          requireProtection()
          try {
            checkVaultStat(await lstat(path))
            if (
              process.platform === 'win32' &&
              !(await restrictWindowsPath(path, false, context))
            ) {
              throw new Error('unsafe vault ACL')
            }
            const bytes = await readFile(path)
            remainingAccountOperationMs(context)
            if (bytes.length > MAX_VAULT_BYTES) {
              throw new Error('oversized vault')
            }
            return parseVault(bytes, authority)
          } catch {
            throw new Error(READ_ERROR)
          }
        }
        return operation ? run(operation) : withAntigravityAccountOperation(run)
      },
      write(vault, operation) {
        const run = async (context: AntigravityAccountOperation): Promise<void> => {
          remainingAccountOperationMs(context)
          requireProtection()
          try {
            await writeProtectedFileAtomic(path, encryptedVault(vault, authority), context)
          } catch {
            throw new Error(
              'Antigravity account snapshots could not be saved; refresh to verify the result.'
            )
          }
        }
        return operation ? run(operation) : withAntigravityAccountOperation(run)
      }
    }
  }
  return {
    read(operation) {
      if (operation) {
        remainingAccountOperationMs(operation)
      }
      if (!existsSync(path)) {
        return { accounts: [], selectedAccountId: null }
      }
      requireProtection()
      try {
        checkVaultStat(lstatSync(path))
        return parseVault(readFileSync(path))
      } catch {
        throw new Error(READ_ERROR)
      }
    },
    write(vault, operation) {
      if (operation) {
        remainingAccountOperationMs(operation)
      }
      requireProtection()
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      try {
        writeCredentialFileAtomic(path, encryptedVault(vault))
        if (process.platform !== 'win32' && (statSync(path).mode & 0o077) !== 0) {
          throw new Error('unsafe permissions')
        }
      } catch {
        throw new Error('Antigravity account snapshots could not be saved.')
      }
    }
  }
}
