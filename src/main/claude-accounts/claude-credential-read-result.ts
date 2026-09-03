import { isTransientKeychainError } from './keychain'

/**
 * Why three states: a Keychain that cannot be read is not an account without credentials.
 * Collapsing `unavailable` into `null` is what makes a locked Keychain look like a signed-out
 * account, and callers then deselect the account or delete the credential it still has.
 */
export type ClaudeCredentialUnavailableReason =
  | 'keychain-transient'
  | 'malformed'
  | 'stale-fallback-present'
  | 'ownership-indeterminate'

export type ClaudeCredentialReadResult =
  | { kind: 'present'; credentialsJson: string }
  | { kind: 'absent' }
  | { kind: 'unavailable'; reason: ClaudeCredentialUnavailableReason }

export const CLAUDE_CREDENTIALS_ABSENT: ClaudeCredentialReadResult = { kind: 'absent' }

export function claudeCredentialsUnavailable(
  reason: ClaudeCredentialUnavailableReason
): ClaudeCredentialReadResult {
  return { kind: 'unavailable', reason }
}

/** A non-empty blob that does not parse to an object is torn, not missing. */
export function classifyClaudeCredentialsBlob(
  credentialsJson: string | null
): ClaudeCredentialReadResult {
  if (credentialsJson === null || credentialsJson.trim() === '') {
    return CLAUDE_CREDENTIALS_ABSENT
  }
  try {
    const parsed: unknown = JSON.parse(credentialsJson)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return claudeCredentialsUnavailable('malformed')
    }
  } catch {
    return claudeCredentialsUnavailable('malformed')
  }
  return { kind: 'present', credentialsJson }
}

type ComposedReadSources = {
  /** Reads the config-dir-scoped Keychain item. Throws on Keychain failure. */
  readScopedKeychain: () => Promise<string | null>
  /** Reads `<configDir>/.credentials.json`. */
  readSameHomeFile: () => string | null
  /** True when a previous write left a stale fallback file it could not clear. */
  hasStaleFallbackMarker?: () => boolean
}

/**
 * The CLI's own contract: Keychain primary, same-home `.credentials.json` fallback.
 *
 * Why a transient failure must not reach the file: the file is a durable-outage fallback that can
 * hold an already-rotated token. Serving it because the Keychain was momentarily locked replays a
 * spent refresh token, and the server revokes the whole family.
 */
export async function readComposedClaudeCredentials(
  sources: ComposedReadSources
): Promise<ClaudeCredentialReadResult> {
  let scoped: string | null = null
  try {
    scoped = await sources.readScopedKeychain()
  } catch (error) {
    if (isTransientKeychainError(error)) {
      return claudeCredentialsUnavailable('keychain-transient')
    }
    scoped = null
  }

  const scopedResult = classifyClaudeCredentialsBlob(scoped)
  if (scopedResult.kind !== 'absent') {
    return scopedResult
  }

  // A write that could not clear its fallback leaves a token we already replaced.
  if (sources.hasStaleFallbackMarker?.()) {
    return claudeCredentialsUnavailable('stale-fallback-present')
  }
  return classifyClaudeCredentialsBlob(sources.readSameHomeFile())
}
