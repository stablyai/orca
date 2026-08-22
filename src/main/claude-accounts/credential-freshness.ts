/** Monotonic writes for credentials the caller has already matched to one account. */

export type CredentialWriteDecision = 'write' | 'keep-existing'

const MAX_TRUSTED_EXPIRY_MS = 100_000_000_000_000

export function readCredentialExpiresAt(credentialsJson: string): number | null {
  const oauth = readOauthRecord(credentialsJson)
  if (!oauth) {
    return null
  }
  const value =
    readFiniteNumber(oauth.expiresAt) ??
    readFiniteNumber(oauth.expires_at) ??
    readFiniteNumber(oauth.expiry) ??
    readFiniteNumber(oauth.expires)
  if (value === null) {
    return null
  }
  // Why: older producers used epoch seconds while current Claude uses epoch milliseconds.
  const normalized = value > 0 && value < 100_000_000_000 ? value * 1000 : value
  return normalized <= MAX_TRUSTED_EXPIRY_MS ? normalized : null
}

/**
 * Identity/account-switch decisions belong to the caller, which has account metadata.
 * Unknown existing expiry is preserved unless the caller proves candidate direction.
 */
export function decideMonotonicCredentialWrite(input: {
  candidateJson: string
  existingJson: string | null
  equalExpiry?: 'write' | 'keep-existing'
  unknownExistingExpiry?: 'write' | 'keep-existing'
}): CredentialWriteDecision {
  const { candidateJson, existingJson } = input
  if (existingJson === null || existingJson === '') {
    return 'write'
  }
  if (!isCredentialsObject(existingJson)) {
    return 'write'
  }
  if (!isCredentialsObject(candidateJson)) {
    return 'keep-existing'
  }
  const candidateExpiresAt = readCredentialExpiresAt(candidateJson)
  const existingExpiresAt = readCredentialExpiresAt(existingJson)

  if (existingExpiresAt === null && candidateExpiresAt === null) {
    return input.unknownExistingExpiry ?? 'keep-existing'
  }
  if (candidateExpiresAt === null) {
    return 'keep-existing'
  }
  if (existingExpiresAt === null) {
    return input.unknownExistingExpiry ?? 'keep-existing'
  }
  if (candidateExpiresAt < existingExpiresAt) {
    return 'keep-existing'
  }
  if (candidateExpiresAt === existingExpiresAt) {
    return input.equalExpiry ?? 'keep-existing'
  }
  return 'write'
}

export function pickFreshestCredentialsJson(
  candidates: (string | null | undefined)[]
): string | null {
  let freshest: string | null = null
  let freshestExpiresAt: number | null = null
  for (const candidate of candidates) {
    if (!candidate || !isCredentialsObject(candidate)) {
      continue
    }
    const expiresAt = readCredentialExpiresAt(candidate)
    if (freshest === null) {
      freshest = candidate
      freshestExpiresAt = expiresAt
      continue
    }
    // Why: an unknown expiry is incomparable; preserve the caller's store precedence.
    if (expiresAt !== null && freshestExpiresAt !== null && expiresAt > freshestExpiresAt) {
      freshest = candidate
      freshestExpiresAt = expiresAt
    }
  }
  return freshest
}

function isCredentialsObject(credentialsJson: string): boolean {
  try {
    const parsed = JSON.parse(credentialsJson) as unknown
    return Boolean(parsed && typeof parsed === 'object' && !Array.isArray(parsed))
  } catch {
    return false
  }
}

function readOauthRecord(credentialsJson: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(credentialsJson) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null
    }
    const oauth = (parsed as Record<string, unknown>).claudeAiOauth
    if (!oauth || typeof oauth !== 'object' || Array.isArray(oauth)) {
      return null
    }
    return oauth as Record<string, unknown>
  } catch {
    return null
  }
}

function readFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}
