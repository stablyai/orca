import { existsSync, readFileSync } from 'node:fs'
import { getSecretStore } from '../../shared/secret-store'

/** Why a credential file this host holds cannot be used; absent when it can be. */
export type SavedCredentialUnreadable =
  /** Sealed by the other Orca app on this machine: the desktop (safeStorage) and orcad (its own
   *  host key) share ~/.orca but cannot open each other's files. */
  | 'sealed-elsewhere'
  /** Corrupt, not readable by this user, or this host cannot decrypt anything right now. */
  | 'unreadable'

export type SavedCredentialFile = {
  path: string
  envelopePrefix: string
  /** The store also accepts pre-envelope files, which carry nothing to judge them by. */
  legacyRaw?: boolean
}

/** Why: orcad reports encryption available before (or without) loading its key, then throws. */
function secretStoreWorks(): boolean {
  try {
    const store = getSecretStore()
    return (
      store.decryptString(store.encryptString('orca-secret-store-probe')) ===
      'orca-secret-store-probe'
    )
  } catch {
    return false
  }
}

/**
 * Reads the file itself, never the store's in-memory copy, so a file the other app rewrote is
 * judged as it is now. Logs nothing: Settings polls this.
 */
export function savedCredentialUnreadable(
  file: SavedCredentialFile
): SavedCredentialUnreadable | undefined {
  if (!existsSync(file.path)) {
    return undefined
  }
  let text: string
  try {
    text = readFileSync(file.path, 'utf8')
  } catch {
    return 'unreadable'
  }
  if (!text.startsWith(file.envelopePrefix)) {
    return file.legacyRaw ? undefined : 'unreadable'
  }
  const rest = text.slice(file.envelopePrefix.length)
  const separator = rest.indexOf(':')
  const kind = separator === -1 ? null : rest.slice(0, separator)
  if (kind === 'plaintext') {
    return undefined
  }
  if (kind !== 'encrypted') {
    return 'unreadable'
  }
  const payload = rest.slice(separator + 1).trim()
  const cipher = Buffer.from(payload, 'base64')
  // Why: Buffer decodes malformed base64 leniently, and that garbage would read as sealed elsewhere.
  if (cipher.length === 0 || cipher.toString('base64') !== payload) {
    return 'unreadable'
  }
  const secretStore = getSecretStore()
  if (!secretStore.isEncryptionAvailable() || !secretStoreWorks()) {
    return 'unreadable'
  }
  try {
    secretStore.decryptString(cipher)
    return undefined
  } catch {
    // Why only here: a well-formed sealed file that a working store cannot open came from another.
    return 'sealed-elsewhere'
  }
}

/** A paired client must not overwrite what the other Orca app on this machine reads. */
export function refuseCredentialSealedElsewhere(credentialName: string): never {
  throw new Error(
    `The ${credentialName} on this computer was saved by another Orca app here, which this one cannot read. Change it in that app, or forget it here first.`
  )
}
