import { readFile } from 'node:fs/promises'
import {
  classifyUnenvelopedCredential,
  type SecretAtRestProtection
} from '../../shared/secure-storage/secret-at-rest-protection'

/** Classify unenveloped token/ciphertext bytes without decrypting or prompting for the keychain. */
export async function readCredentialFileProtection(
  path: string
): Promise<SecretAtRestProtection | null> {
  try {
    const raw = await readFile(path)
    return raw.length === 0 ? null : classifyUnenvelopedCredential(raw)
  } catch {
    // Unreadable is a read-time error to surface elsewhere, not a protection claim.
    return null
  }
}
