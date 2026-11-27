import { credentialFileExists, inCredentialFileOrder } from '../credentials/credential-file-io'
import { lstat, mkdir, readFile, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { getSecretStore } from '../../shared/secure-storage/secret-store'
import { writeCredentialFileAtomic } from '../credentials/integration-credential-file'
import type { AntigravityAccountSummary } from '../../shared/agent-accounts/antigravity/antigravity-account-types'
import { parseAntigravityNativeCredential } from './native-credential-codec'
import { readPrivateWindowsCredentialFile } from '../../shared/secure-storage/windows-credential-file-io'

export type StoredAntigravityAccount = AntigravityAccountSummary & {
  credentials: string
}
export type AntigravityAccountVault = {
  accounts: StoredAntigravityAccount[]
  selectedAccountId: string | null
}
export type AntigravityAccountStore = {
  read(): Promise<AntigravityAccountVault>
  write(vault: AntigravityAccountVault): Promise<void>
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

export function createEncryptedAntigravityAccountStore(
  path: string,
  parseCredential = parseAntigravityNativeCredential
): AntigravityAccountStore {
  return {
    async read() {
      return inCredentialFileOrder(`${path}.mutation`, async () => {
        if (!(await credentialFileExists(path))) {
          return { accounts: [], selectedAccountId: null }
        }
        requireProtection()
        try {
          const stat = await lstat(path)
          if (
            !stat.isFile() ||
            stat.size > MAX_VAULT_BYTES ||
            (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)
          ) {
            throw new Error('unsafe vault')
          }
          const raw =
            process.platform === 'win32'
              ? await readPrivateWindowsCredentialFile(path, MAX_VAULT_BYTES)
              : await readFile(path)
          if (!raw) {
            throw new Error('vault disappeared')
          }
          const value: unknown = JSON.parse(getSecretStore().decryptString(raw))
          if (
            !isRecord(value) ||
            !Array.isArray(value.accounts) ||
            !value.accounts.every(isAccount) ||
            (value.selectedAccountId !== null && typeof value.selectedAccountId !== 'string')
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
            const credential = parseCredential(account.credentials)
            // agy refreshes drop the id_token, so a saved account may hold a credential without one.
            if (
              credential.authMethod !== account.authMethod ||
              (credential.identity !== null && credential.identity.subject !== account.subject)
            ) {
              throw new Error('inconsistent identity')
            }
          }
          return {
            // Older builds cached quota readings in `usage`; drop them so the next write removes them.
            accounts: value.accounts.map(
              ({ usage: _usage, ...account }: StoredAntigravityAccount & { usage?: unknown }) =>
                account
            ),
            selectedAccountId: value.selectedAccountId
          }
        } catch {
          throw new Error(
            'Antigravity account snapshots could not be read; the existing vault was preserved.'
          )
        }
      })
    },
    async write(vault) {
      return inCredentialFileOrder(`${path}.mutation`, async () => {
        requireProtection()
        await mkdir(dirname(path), { recursive: true, mode: 0o700 })
        try {
          const encrypted = getSecretStore().encryptString(JSON.stringify(vault))
          if (encrypted.length > MAX_VAULT_BYTES) {
            throw new Error('vault exceeds readable size')
          }
          await writeCredentialFileAtomic(path, encrypted, undefined, true)
          if (process.platform !== 'win32' && ((await stat(path)).mode & 0o077) !== 0) {
            throw new Error('unsafe permissions')
          }
        } catch {
          throw new Error('Antigravity account snapshots could not be saved.')
        }
      })
    }
  }
}
