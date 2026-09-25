import type { ProtectedSecretPersistence } from '../../protected-secret-persistence'

// Why a private slot: #22551 sealed the key under this name; only this migration still reads it.
export const LEGACY_OPENCODE_GO_API_KEY_SLOT = 'settings.opencodeGoApiKey'

type LegacyOpenCodeGoApiKeySecrets = Pick<
  ProtectedSecretPersistence,
  'decryptWithStatus' | 'removeRetainedBlob' | 'retainSealed' | 'sealedBlob'
>

export type OpenCodeGoApiKeyTarget = {
  has: () => boolean
  /** Throws when the saved key cannot be read or decrypted by this build. */
  read: () => string | null
  save: (key: string) => void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// #22551 accepted a plaintext `sk-`/`oc_sk_` value that failed to decrypt; keep honoring it.
function isLegacyPlaintextOpenCodeGoApiKey(value: string): boolean {
  return /^(?:oc_)?sk[-_][A-Za-z0-9._-]+$/.test(value.trim())
}

/**
 * Moves the #22551 settings value out of settings and parks its ciphertext undecrypted, so every
 * Store consumer (orcad included) writes it back until the desktop migration gives it a new home.
 */
export function retainLegacyOpenCodeGoApiKey(
  settings: unknown,
  secrets: Pick<ProtectedSecretPersistence, 'encrypt' | 'retainSealed'>
): void {
  if (!isRecord(settings) || !('opencodeGoApiKey' in settings)) {
    return
  }
  const sealed = settings.opencodeGoApiKey
  // Why: in-memory settings reach the renderer and remote settings.get; the key must not ride along.
  delete settings.opencodeGoApiKey
  if (typeof sealed !== 'string' || !sealed) {
    return
  }
  if (!isLegacyPlaintextOpenCodeGoApiKey(sealed)) {
    secrets.retainSealed(LEGACY_OPENCODE_GO_API_KEY_SLOT, sealed)
    return
  }
  // Why: orcad-only profiles never migrate, so seal it now; without encryption #22551 kept it plaintext too.
  const encrypted = secrets.encrypt(LEGACY_OPENCODE_GO_API_KEY_SLOT, sealed)
  secrets.retainSealed(
    LEGACY_OPENCODE_GO_API_KEY_SLOT,
    encrypted.degraded ? sealed : encrypted.blob
  )
}

/**
 * Saves the parked key into the main-owned store; a key already saved there wins.
 * @returns True once the legacy value is released and may be dropped from disk.
 */
export function migrateLegacyOpenCodeGoApiKey(
  secrets: LegacyOpenCodeGoApiKeySecrets,
  target: OpenCodeGoApiKeyTarget
): boolean {
  const sealed = secrets.sealedBlob(LEGACY_OPENCODE_GO_API_KEY_SLOT)
  if (!sealed) {
    return false
  }
  try {
    // Why: a file another app identity sealed is unreadable here; read throws and keeps the legacy key.
    const existing = target.has() ? target.read() : null
    if (existing === null) {
      const decrypted = secrets.decryptWithStatus(
        LEGACY_OPENCODE_GO_API_KEY_SLOT,
        sealed,
        isLegacyPlaintextOpenCodeGoApiKey
      )
      // Why keep a definitive failure too: a restored keychain can still open the inert ciphertext, while dropping it is irreversible.
      if (decrypted.status === 'unavailable' || !decrypted.plaintext) {
        secrets.retainSealed(LEGACY_OPENCODE_GO_API_KEY_SLOT, sealed)
        return false
      }
      const key = decrypted.plaintext.trim()
      if (key) {
        target.save(key)
      }
    } else {
      // Why: the store is machine-wide, so another profile's key can win; leave a trace of the drop.
      console.warn(
        '[opencode-go] Kept the existing saved API key and dropped the one from settings.'
      )
    }
  } catch {
    // Why: startup must not fail on a disk or keychain error; the next startup retries.
    secrets.retainSealed(LEGACY_OPENCODE_GO_API_KEY_SLOT, sealed)
    console.warn('[opencode-go] Could not migrate the saved API key out of settings.')
    return false
  }
  secrets.removeRetainedBlob(LEGACY_OPENCODE_GO_API_KEY_SLOT)
  return true
}
