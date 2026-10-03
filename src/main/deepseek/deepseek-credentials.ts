import { createHash } from 'node:crypto'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { getSecretStore } from '../../shared/secret-store'
import { hardenExistingSecureFile, writeSecureFile } from '../../shared/secure-file'
import type { DeepSeekAccountStatus } from '../../shared/deepseek-balance'

const ENVELOPE = 'orca-deepseek-key:v1:'

export class DeepSeekCredentials {
  private protectedStorageAvailable = false
  constructor(
    readonly ownerId: string,
    private readonly path = join(homedir(), '.orca', 'deepseek-api-key.enc')
  ) {}

  getStatus(probeProtection = true): DeepSeekAccountStatus {
    if (probeProtection) {
      this.protectedStorageAvailable = this.canProtect()
    }
    let sealed = false
    try {
      sealed = readFileSync(this.path, 'utf8').startsWith(ENVELOPE)
    } catch {
      /* Presence remains available when the file cannot be read. */
    }
    return {
      supported: this.protectedStorageAvailable,
      configured: existsSync(this.path),
      ownerId: this.ownerId,
      protection: sealed ? 'sealed' : null
    }
  }

  revision(): string | null {
    try {
      return createHash('sha256').update(readFileSync(this.path)).digest('hex')
    } catch {
      return null
    }
  }

  read(): string | null {
    if (!existsSync(this.path)) {
      return null
    }
    if (!this.canProtect()) {
      throw new Error('DeepSeek protected storage is unavailable')
    }
    try {
      hardenExistingSecureFile(this.path)
      const raw = readFileSync(this.path, 'utf8')
      if (!raw.startsWith(ENVELOPE)) {
        throw new Error('Invalid envelope')
      }
      return getSecretStore().decryptString(Buffer.from(raw.slice(ENVELOPE.length), 'base64'))
    } catch {
      throw new Error('DeepSeek API key could not be read from protected storage')
    }
  }

  save(ownerId: string, value: string): DeepSeekAccountStatus {
    this.requireOwner(ownerId)
    if (typeof value !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(value.trim())) {
      throw new Error('Enter a valid DeepSeek API key')
    }
    if (!this.canProtect()) {
      throw new Error('DeepSeek protected storage is unavailable')
    }
    try {
      const sealed = getSecretStore().encryptString(value.trim()).toString('base64')
      if (!writeSecureFile(this.path, `${ENVELOPE}${sealed}`, { durable: true })) {
        throw new Error('Permission restriction failed')
      }
    } catch {
      throw new Error('DeepSeek API key could not be saved in protected storage')
    }
    return this.getStatus()
  }

  remove(ownerId: string): DeepSeekAccountStatus {
    this.requireOwner(ownerId)
    try {
      rmSync(this.path, { force: true })
    } catch {
      throw new Error('DeepSeek API key could not be removed')
    }
    return this.getStatus()
  }

  private requireOwner(ownerId: string): void {
    if (ownerId !== this.ownerId) {
      throw new Error('DeepSeek account owner changed; reload Accounts')
    }
  }

  private canProtect(): boolean {
    try {
      const store = getSecretStore()
      return store.isEncryptionAvailable() && store.describeProtectionGap() === null
    } catch {
      return false
    }
  }
}
