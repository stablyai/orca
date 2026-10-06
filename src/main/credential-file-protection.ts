import { existsSync, readFileSync } from 'node:fs'
import {
  classifyUnenvelopedCredential,
  type SecretAtRestProtection
} from '../shared/secret-at-rest-protection'

/**
 * How the credential file at `path` is protected, or null when there is nothing there.
 *
 * Why every unenveloped store shares this: speech, Linear, Jira and Bitbucket all write
 * either `safeStorage` ciphertext or the bare token with nothing on disk to distinguish
 * them, so each would otherwise grow its own sniff — and a reporter that disagrees with
 * the reader about the same bytes is worse than no reporter.
 *
 * Never decrypts. Settings calls this on open, and a decrypt would put an OS keychain
 * prompt in front of someone who only opened a settings pane.
 */
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
