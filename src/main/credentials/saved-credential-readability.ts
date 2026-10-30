import { existsSync, readFileSync } from 'node:fs'
import { getSecretStore } from '../../shared/secret-store'

export type SavedCredentialUnreadable =
  /** Desktop safeStorage and orcad host keys cannot decrypt each other's files in ~/.orca. */
  'sealed-elsewhere' | 'unreadable'

export type SavedCredentialFile = {
  path: string
  envelopePrefix: string
  /** Accept legacy files that have no envelope metadata to inspect. */
  legacyRaw?: boolean
}

// Orcad can report encryption available before its host key is loaded; probe actual use.
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

/** Read disk to see other-app rewrites; stay silent because Settings polls this. */
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
  // Reject malformed base64 before it can be mistaken for a foreign sealed credential.
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
    // Classify decryption failure as foreign only after checking format and store health.
    return 'sealed-elsewhere'
  }
}

/** Prevent paired clients from overwriting credentials sealed by another local Orca app. */
export function refuseCredentialSealedElsewhere(credentialName: string): never {
  throw new Error(
    `The ${credentialName} on this computer was saved by another Orca app here, which this one cannot read. Change it in that app, or forget it here first.`
  )
}
