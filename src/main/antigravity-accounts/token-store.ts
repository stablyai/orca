import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { app, safeStorage } from 'electron'

export type AntigravityAccountTokens = {
  refreshToken: string
  accessToken: string | null
  expiryDate: number | null
}

type VaultFile = {
  version: 1
  /** base64(safeStorage.encryptString(JSON.stringify(tokens))) per account id */
  entries: Record<string, string>
}

export type AntigravityTokenStore = {
  read: (accountId: string) => Promise<AntigravityAccountTokens | null>
  write: (accountId: string, tokens: AntigravityAccountTokens) => Promise<void>
  remove: (accountId: string) => Promise<void>
}

function vaultFilePath(): string {
  return path.join(app.getPath('userData'), 'antigravity-accounts-vault.json')
}

function encodeTokens(tokens: AntigravityAccountTokens): string {
  return safeStorage.encryptString(JSON.stringify(tokens)).toString('base64')
}

function decodeTokens(entry: string): AntigravityAccountTokens | null {
  try {
    const buffer = Buffer.from(entry, 'base64')
    const plain = safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buffer) : null
    if (!plain) {
      return null
    }
    const parsed = JSON.parse(plain) as Partial<AntigravityAccountTokens>
    if (typeof parsed.refreshToken !== 'string' || !parsed.refreshToken) {
      return null
    }
    return {
      refreshToken: parsed.refreshToken,
      accessToken: typeof parsed.accessToken === 'string' ? parsed.accessToken : null,
      expiryDate: typeof parsed.expiryDate === 'number' ? parsed.expiryDate : null
    }
  } catch {
    return null
  }
}

async function readVault(): Promise<VaultFile> {
  try {
    const raw = await readFile(vaultFilePath(), 'utf-8')
    const parsed = JSON.parse(raw) as Partial<VaultFile>
    if (
      parsed &&
      typeof parsed === 'object' &&
      parsed.entries &&
      typeof parsed.entries === 'object'
    ) {
      return { version: 1, entries: parsed.entries }
    }
  } catch {
    // Missing or corrupt vault behaves as empty.
  }
  return { version: 1, entries: {} }
}

async function writeVault(vault: VaultFile): Promise<void> {
  const target = vaultFilePath()
  await mkdir(path.dirname(target), { recursive: true })
  const tmp = `${target}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(vault, null, 2), 'utf-8')
  await rename(tmp, target)
}

export function createAntigravityTokenStore(): AntigravityTokenStore {
  return {
    read: async (accountId) => {
      const vault = await readVault()
      const entry = vault.entries[accountId]
      return entry ? decodeTokens(entry) : null
    },
    write: async (accountId, tokens) => {
      // Why: refuse to persist plaintext when OS-level encryption is missing
      // (headless Linux without libsecret) rather than leak refresh tokens.
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error('OS keyring encryption unavailable; Antigravity account not saved')
      }
      const vault = await readVault()
      vault.entries[accountId] = encodeTokens(tokens)
      await writeVault(vault)
    },
    remove: async (accountId) => {
      if (!existsSync(vaultFilePath())) {
        return
      }
      const vault = await readVault()
      if (!(accountId in vault.entries)) {
        return
      }
      delete vault.entries[accountId]
      await writeVault(vault)
    }
  }
}
