import type { ProtectedSecretPersistence } from '../../protected-secret-persistence'

// Only migration reads the former encrypted settings slot.
export const LEGACY_OPENCODE_GO_API_KEY_SLOT = 'settings.opencodeGoApiKey'

type LegacyOpenCodeGoApiKeySecrets = Pick<
  ProtectedSecretPersistence,
  'decryptWithStatus' | 'removeRetainedBlob' | 'retainSealed' | 'sealedBlob'
>

export type OpenCodeGoApiKeyTarget = {
  has: () => boolean
  read: () => string | null
  save: (key: string) => void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// Legacy storage accepted plaintext key-shaped values after decryption failure.
function isLegacyPlaintextOpenCodeGoApiKey(value: string): boolean {
  return /^(?:oc_)?sk[-_][A-Za-z0-9._-]+$/.test(value.trim())
}

/** Retain ciphertext outside settings until migration can move the key into main-owned storage. */
export function retainLegacyOpenCodeGoApiKey(
  settings: unknown,
  secrets: Pick<ProtectedSecretPersistence, 'encrypt' | 'retainSealed'>
): void {
  if (!isRecord(settings) || !('opencodeGoApiKey' in settings)) {
    return
  }
  const sealed = settings.opencodeGoApiKey
  // Settings reach renderers and remote clients; never expose the retained key there.
  delete settings.opencodeGoApiKey
  if (typeof sealed !== 'string' || !sealed) {
    return
  }
  if (!isLegacyPlaintextOpenCodeGoApiKey(sealed)) {
    secrets.retainSealed(LEGACY_OPENCODE_GO_API_KEY_SLOT, sealed)
    return
  }
  // Headless-only profiles may never migrate; seal their legacy plaintext now.
  const encrypted = secrets.encrypt(LEGACY_OPENCODE_GO_API_KEY_SLOT, sealed)
  secrets.retainSealed(
    LEGACY_OPENCODE_GO_API_KEY_SLOT,
    encrypted.degraded ? sealed : encrypted.blob
  )
}

/** Prefer an existing main-owned key; true permits dropping the retained legacy slot. */
export function migrateLegacyOpenCodeGoApiKey(
  secrets: LegacyOpenCodeGoApiKeySecrets,
  target: OpenCodeGoApiKeyTarget
): boolean {
  const sealed = secrets.sealedBlob(LEGACY_OPENCODE_GO_API_KEY_SLOT)
  if (!sealed) {
    return false
  }
  try {
    // Another app identity may own this key; read failure must retain the legacy copy.
    const existing = target.has() ? target.read() : null
    if (existing === null) {
      const decrypted = secrets.decryptWithStatus(
        LEGACY_OPENCODE_GO_API_KEY_SLOT,
        sealed,
        isLegacyPlaintextOpenCodeGoApiKey
      )
      // Retain failed ciphertext in case a restored keychain can recover it.
      if (decrypted.status === 'unavailable' || !decrypted.plaintext) {
        secrets.retainSealed(LEGACY_OPENCODE_GO_API_KEY_SLOT, sealed)
        return false
      }
      const key = decrypted.plaintext.trim()
      if (key) {
        target.save(key)
      }
    } else {
      // Another profile may already own the machine-wide key; report the discarded duplicate.
      console.warn(
        '[opencode-go] Kept the existing saved API key and dropped the one from settings.'
      )
    }
  } catch {
    // Preserve ciphertext and retry startup migration after disk/keychain failures.
    secrets.retainSealed(LEGACY_OPENCODE_GO_API_KEY_SLOT, sealed)
    console.warn('[opencode-go] Could not migrate the saved API key out of settings.')
    return false
  }
  secrets.removeRetainedBlob(LEGACY_OPENCODE_GO_API_KEY_SLOT)
  return true
}
