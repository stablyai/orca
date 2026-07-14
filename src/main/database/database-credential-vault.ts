import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { writeSecureJsonFile } from '../../shared/secure-file'
import {
  ElectronDatabaseVaultKeyProtection,
  type DatabaseVaultKeyProtection,
  type ProtectedDatabaseVaultKey
} from './database-vault-key-protection'

const DATABASE_VAULT_VERSION = 1
const DATABASE_VAULT_KEY_BYTES = 32
const DATABASE_VAULT_IV_BYTES = 12
const DATABASE_VAULT_KEY_FILE = 'database-vault-key.json'
const DATABASE_CREDENTIAL_FILE = 'database-credentials.json'

const StoredKeySchema = z.object({
  version: z.literal(DATABASE_VAULT_VERSION),
  protection: z.enum(['os', 'local-file']),
  payload: z.string().min(1)
})

const EncryptedCredentialSchema = z.object({
  iv: z.string().min(1),
  ciphertext: z.string(),
  tag: z.string().min(1)
})

const CredentialFileSchema = z.object({
  version: z.literal(DATABASE_VAULT_VERSION),
  credentials: z.record(z.string(), EncryptedCredentialSchema)
})

type CredentialFile = z.infer<typeof CredentialFileSchema>

export class DatabaseCredentialVault {
  private readonly keyPath: string
  private readonly credentialPath: string
  private readonly keyProtection: DatabaseVaultKeyProtection
  private key: Buffer | null = null

  constructor(
    profileDirectory: string,
    keyProtection: DatabaseVaultKeyProtection = new ElectronDatabaseVaultKeyProtection()
  ) {
    this.keyPath = join(profileDirectory, DATABASE_VAULT_KEY_FILE)
    this.credentialPath = join(profileDirectory, DATABASE_CREDENTIAL_FILE)
    this.keyProtection = keyProtection
  }

  has(profileId: string): boolean {
    return Boolean(this.readCredentials().credentials[profileId])
  }

  get(profileId: string): string | null {
    const stored = this.readCredentials().credentials[profileId]
    if (!stored) {
      return null
    }
    try {
      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.getOrCreateKey(),
        Buffer.from(stored.iv, 'base64')
      )
      decipher.setAAD(Buffer.from(profileId, 'utf8'))
      decipher.setAuthTag(Buffer.from(stored.tag, 'base64'))
      return Buffer.concat([
        decipher.update(Buffer.from(stored.ciphertext, 'base64')),
        decipher.final()
      ]).toString('utf8')
    } catch {
      throw new Error('The saved database password could not be decrypted')
    }
  }

  set(profileId: string, password: string): void {
    const state = this.readCredentials()
    const iv = randomBytes(DATABASE_VAULT_IV_BYTES)
    const cipher = createCipheriv('aes-256-gcm', this.getOrCreateKey(), iv)
    cipher.setAAD(Buffer.from(profileId, 'utf8'))
    const ciphertext = Buffer.concat([cipher.update(password, 'utf8'), cipher.final()])
    this.writeCredentials({
      version: DATABASE_VAULT_VERSION,
      credentials: {
        ...state.credentials,
        [profileId]: {
          iv: iv.toString('base64'),
          ciphertext: ciphertext.toString('base64'),
          tag: cipher.getAuthTag().toString('base64')
        }
      }
    })
  }

  delete(profileId: string): boolean {
    const state = this.readCredentials()
    if (!state.credentials[profileId]) {
      return false
    }
    const credentials = { ...state.credentials }
    delete credentials[profileId]
    this.writeCredentials({ version: DATABASE_VAULT_VERSION, credentials })
    return true
  }

  private getOrCreateKey(): Buffer {
    if (this.key) {
      return this.key
    }
    if (existsSync(this.keyPath)) {
      const stored = this.readStoredKey()
      this.key = this.keyProtection.unprotect(stored)
    } else {
      this.key = randomBytes(DATABASE_VAULT_KEY_BYTES)
      writeSecureJsonFile(this.keyPath, {
        version: DATABASE_VAULT_VERSION,
        ...this.keyProtection.protect(this.key)
      })
    }
    if (this.key.byteLength !== DATABASE_VAULT_KEY_BYTES) {
      this.key = null
      throw new Error('The database vault key is invalid')
    }
    return this.key
  }

  private readStoredKey(): ProtectedDatabaseVaultKey {
    try {
      const parsed = StoredKeySchema.parse(JSON.parse(readFileSync(this.keyPath, 'utf8')))
      return { protection: parsed.protection, payload: parsed.payload }
    } catch {
      throw new Error('The database vault key is invalid')
    }
  }

  private readCredentials(): CredentialFile {
    if (!existsSync(this.credentialPath)) {
      return { version: DATABASE_VAULT_VERSION, credentials: {} }
    }
    try {
      return CredentialFileSchema.parse(JSON.parse(readFileSync(this.credentialPath, 'utf8')))
    } catch {
      throw new Error('The database credential vault is invalid and was not modified')
    }
  }

  private writeCredentials(value: CredentialFile): void {
    writeSecureJsonFile(this.credentialPath, value)
  }
}
