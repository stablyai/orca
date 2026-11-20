import { getSecretStore } from '../../shared/secure-storage/secret-store'

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
  epoch: symbol
}

export type LegacyPlaintextValidator = (value: string) => boolean

/** One protected value the next save will write. */
export type ProtectedSecretPlaintext = { slot: string; plaintext: string }

type SealRequest = { plaintext: string; settled: Promise<void> }

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
  private readonly pendingEncryption = new Set<string>()
  private readonly retentionEpochs = new Map<string, symbol>()
  // Ciphertext sealed ahead of a save, valid only for the exact plaintext it sealed.
  private readonly readySeals = new Map<string, { plaintext: string; blob: string }>()
  private readonly sealRequests = new Map<string, SealRequest>()
  // Plaintext whose seal failed during this save; its capture degrades instead of sealing again.
  private readonly failedSeals = new Map<string, string>()

  hasPendingEncryption(): boolean {
    return this.pendingEncryption.size > 0
  }

  removeRetainedBlob(slot: string): void {
    // A cleared or replaced secret drops its seals, so a late seal cannot write the old value back.
    this.readySeals.delete(slot)
    this.sealRequests.delete(slot)
    this.failedSeals.delete(slot)
    this.retentionEpochs.delete(slot)
    this.retainedBlobs.delete(slot)
    this.sealedSlots.delete(slot)
    this.pendingEncryption.delete(slot)
  }

  /** Parks ciphertext without allowing an earlier pending write to replace it. */
  retainSealed(slot: string, blob: string): void {
    this.removeRetainedBlob(slot)
    this.retainedBlobs.set(slot, blob)
    this.sealedSlots.add(slot)
  }

  sealedBlob(slot: string): string | null {
    return this.sealedSlots.has(slot) ? (this.retainedBlobs.get(slot) ?? null) : null
  }

  isSealed(slot: string, value: string): boolean {
    return this.sealedSlots.has(slot) && this.retainedBlobs.get(slot) === value
  }

  commitRetentionUpdates(updates: readonly ProtectedSecretRetentionUpdate[]): void {
    for (const update of updates) {
      // A delayed save must not overwrite a newer secret decision.
      if (this.retentionEpochs.get(update.slot) !== update.epoch) {
        continue
      }
      this.retentionEpochs.delete(update.slot)
      this.pendingEncryption.delete(update.slot)
      if (update.blob === null) {
        this.removeRetainedBlob(update.slot)
      } else {
        this.retainedBlobs.set(update.slot, update.blob)
        this.sealedSlots.delete(update.slot)
      }
    }
  }

  encrypt(slot: string, plaintext: string): ProtectedSecretEncryption {
    this.retentionEpochs.delete(slot)
    const retained = this.retainedBlobs.get(slot) ?? ''
    if (!plaintext && !retained) {
      return {
        blob: '',
        degraded: false,
        ...(this.pendingEncryption.has(slot)
          ? { retentionUpdate: this.prepareRetentionUpdate(slot, null) }
          : {})
      }
    }
    if (!this.encryptionAvailable()) {
      if (!this.isSealed(slot, plaintext) && (plaintext || !this.sealedSlots.has(slot))) {
        this.pendingEncryption.add(slot)
      }
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
        retentionUpdate: this.prepareRetentionUpdate(slot, null)
      }
    }
    try {
      if (this.failedSeals.get(slot) === plaintext) {
        this.failedSeals.delete(slot)
        throw new Error('sealing this value already failed during this save')
      }
      const blob =
        this.readySealFor(slot, plaintext) ??
        getSecretStore().encryptString(plaintext).toString('base64')
      return {
        blob,
        degraded: false,
        retentionUpdate: this.prepareRetentionUpdate(slot, blob)
      }
    } catch (err) {
      this.pendingEncryption.add(slot)
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
    this.retentionEpochs.delete(slot)
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
        plaintext: getSecretStore().decryptString(Buffer.from(ciphertext, 'base64')),
        status: 'decrypted' as const
      }
      this.sealedSlots.delete(slot)
      return decrypted
    } catch {
      if (isLegacyPlaintext?.(ciphertext)) {
        this.sealedSlots.delete(slot)
        console.warn('[persistence] secret decryption failed; accepting legacy plaintext.')
        return { plaintext: ciphertext, status: 'failed' }
      }
      this.sealedSlots.add(slot)
      console.warn(
        '[persistence] secret decryption failed; retaining the protected value without exposing it.'
      )
      return { plaintext: '', status: 'failed' }
    }
  }

  /**
   * Seals the values a save is about to write before it captures them, so the capture needs no
   * synchronous sealing. Null when every value already has its seal or failed to seal. A failed
   * value keeps today's degradation and retention when the save captures it.
   */
  sealAhead(values: readonly ProtectedSecretPlaintext[]): Promise<void> | null {
    const pending: Promise<void>[] = []
    for (const { slot, plaintext } of values) {
      if (!this.needsSeal(slot, plaintext)) {
        continue
      }
      const current = this.sealRequests.get(slot)
      if (current?.plaintext === plaintext) {
        pending.push(current.settled)
        continue
      }
      const request: SealRequest = { plaintext, settled: Promise.resolve() }
      request.settled = sealString(plaintext).then(
        (blob) => {
          // Only the slot's current request may publish; a newer or cleared value supersedes it.
          if (this.sealRequests.get(slot) === request) {
            this.sealRequests.delete(slot)
            this.readySeals.set(slot, { plaintext, blob })
          }
        },
        () => {
          if (this.sealRequests.get(slot) === request) {
            this.sealRequests.delete(slot)
            this.failedSeals.set(slot, plaintext)
          }
        }
      )
      this.sealRequests.set(slot, request)
      pending.push(request.settled)
    }
    return pending.length > 0 ? Promise.all(pending).then(() => {}) : null
  }

  /** Ends a save's failures, so the next save or export tries a failed value again. */
  forgetFailedSeals(): void {
    this.failedSeals.clear()
  }

  private needsSeal(slot: string, plaintext: string): boolean {
    return (
      plaintext !== '' &&
      this.failedSeals.get(slot) !== plaintext &&
      this.readySeals.get(slot)?.plaintext !== plaintext &&
      !this.isSealed(slot, plaintext) &&
      this.encryptionAvailable()
    )
  }

  private readySealFor(slot: string, plaintext: string): string | null {
    const ready = this.readySeals.get(slot)
    return ready?.plaintext === plaintext ? ready.blob : null
  }

  private prepareRetentionUpdate(
    slot: string,
    blob: string | null
  ): ProtectedSecretRetentionUpdate {
    const epoch = Symbol()
    this.retentionEpochs.set(slot, epoch)
    return { slot, blob, epoch }
  }

  private encryptionAvailable(): boolean {
    // Missing store installation is a startup bug; only backend keyring failures may degrade softly.
    const store = getSecretStore()
    try {
      return store.isEncryptionAvailable()
    } catch (err) {
      console.warn('[persistence] secret store availability check failed:', err)
      return false
    }
  }
}

async function sealString(plaintext: string): Promise<string> {
  const store = getSecretStore()
  const sealed = store.encryptStringAsync
    ? await store.encryptStringAsync(plaintext)
    : store.encryptString(plaintext)
  return sealed.toString('base64')
}
