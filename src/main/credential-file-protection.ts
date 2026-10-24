import { existsSync, readFileSync } from 'node:fs'
import {
  classifyUnenvelopedCredential,
  type SecretAtRestProtection
} from '../shared/secret-at-rest-protection'

/** Classify unenveloped token/ciphertext bytes without decrypting or prompting for the keychain. */
export function readCredentialFileProtection(path: string): SecretAtRestProtection | null {
  if (!existsSync(path)) {
    return null
  }
  try {
    const raw = readFileSync(path)
    return raw.length === 0 ? null : classifyUnenvelopedCredential(raw)
  } catch {
    // Unreadable is a read-time error to surface elsewhere, not a protection claim.
    return null
  }
}
