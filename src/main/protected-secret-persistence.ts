import { safeStorage } from 'electron'

export const PROTECTED_SECRET_SLOT = {
  opencodeSessionCookie: 'settings.opencodeSessionCookie',
  httpProxyUrl: 'settings.httpProxyUrl',
  browserKagiSessionLink: 'ui.browserKagiSessionLink'
} as const

export function sshPtyOwnerLeaseSecretSlot(targetId: string): string {
  return `sshPtyConsumerRecoveries.ownerLease:${targetId}`
}

export type ProtectedSecretDecryption = {
  plaintext: string
  status: 'decrypted' | 'failed' | 'unavailable'
}

export type ProtectedSecretRetentionUpdate = {
  slot: string
  blob: string | null
}

export type LegacyPlaintextValidator = (value: string) => boolean

type ProtectedSecretEncryption = {
  blob: string
  degraded: boolean
  hashValue?: string
  retentionUpdate?: ProtectedSecretRetentionUpdate
}

// Preserve prior ciphertext or omit a new secret so unrelated state can still save safely.
export class ProtectedSecretPersistence {
  private readonly retainedBlobs = new Map<string, string>()
  private readonly sealedSlots = new Set<string>()

  removeRetainedBlob(slot: string): void {
    this.retainedBlobs.delete(slot)
    this.sealedSlots.delete(slot)
  }

  isSealed(slot: string, value: string): boolean {
    return this.sealedSlots.has(slot) && this.retainedBlobs.get(slot) === value
  }

  commitRetentionUpdates(updates: readonly ProtectedSecretRetentionUpdate[]): void {
    for (const update of updates) {
      if (update.blob === null) {
        this.removeRetainedBlob(update.slot)
      } else {
        this.retainedBlobs.set(update.slot, update.blob)
        this.sealedSlots.delete(update.slot)
      }
    }
  }

  encrypt(slot: string, plaintext: string): ProtectedSecretEncryption {
    const retained = this.retainedBlobs.get(slot) ?? ''
    if (!plaintext && !retained) {
      return { blob: '', degraded: false }
    }
    if (!this.encryptionAvailable()) {
      return {
        blob: retained,
        degraded: true,
        ...(!plaintext && retained ? { hashValue: retained } : {})
      }
    }
    if (this.isSealed(slot, plaintext) || (!plaintext && this.sealedSlots.has(slot))) {
      return { blob: retained, degraded: false, hashValue: retained }
    }
    if (!plaintext) {
      return {
        blob: '',
        degraded: false,
        retentionUpdate: { slot, blob: null }
      }
    }
    try {
      const blob = safeStorage.encryptString(plaintext).toString('base64')
      return {
        blob,
        degraded: false,
        retentionUpdate: { slot, blob }
      }
    } catch (err) {
      console.error('[persistence] Encryption failed; retaining the prior protected value:', err)
      return { blob: retained, degraded: true }
    }
  }

  decrypt(slot: string, ciphertext: string, isLegacyPlaintext?: LegacyPlaintextValidator): string {
    return this.decryptWithStatus(slot, ciphertext, isLegacyPlaintext).plaintext
  }

  decryptWithStatus(
    slot: string,
    ciphertext: string,
    isLegacyPlaintext?: LegacyPlaintextValidator
  ): ProtectedSecretDecryption {
    if (!ciphertext) {
      this.removeRetainedBlob(slot)
      return { plaintext: '', status: 'decrypted' }
    }
    this.retainedBlobs.set(slot, ciphertext)
    if (!this.encryptionAvailable()) {
      this.sealedSlots.add(slot)
      return { plaintext: '', status: 'unavailable' }
    }
    try {
      const decrypted = {
        plaintext: safeStorage.decryptString(Buffer.from(ciphertext, 'base64')),
        status: 'decrypted' as const
      }
      this.sealedSlots.delete(slot)
      return decrypted
    } catch {
      if (isLegacyPlaintext?.(ciphertext)) {
        this.sealedSlots.delete(slot)
        console.warn('[persistence] safeStorage decryption failed; accepting legacy plaintext.')
        return { plaintext: ciphertext, status: 'failed' }
      }
      this.sealedSlots.add(slot)
      console.warn(
        '[persistence] safeStorage decryption failed; retaining the protected value without exposing it.'
      )
      return { plaintext: '', status: 'failed' }
    }
  }

  private encryptionAvailable(): boolean {
    try {
      return safeStorage.isEncryptionAvailable()
    } catch (err) {
      console.warn('[persistence] safeStorage availability check failed:', err)
      return false
    }
  }
}
