import type { CodexManagedAccount } from '../../shared/managed-account-types'

export type CodexAuthIdentity = {
  email: string | null
  providerAccountId: string | null
  workspaceLabel: string | null
  workspaceAccountId: string | null
}

type CodexAuthOwnershipIdentity = Omit<CodexAuthIdentity, 'workspaceLabel'>

// Why: stale shared-home PTYs can write after an account switch, so read-back
// needs a positive claim match instead of trusting the selected path alone.
export function codexAuthMatchesManagedAccount(
  runtimeAuthContents: string,
  account: CodexManagedAccount,
  managedAuthContents: string | null
): boolean {
  const identity = readCodexAuthIdentity(runtimeAuthContents)
  if (!identity) {
    return false
  }
  const managedIdentity = managedAuthContents ? readCodexAuthIdentity(managedAuthContents) : null
  const selectedEmail = firstNonNull(normalizeField(account.email), managedIdentity?.email)
  const selectedProviderId = firstNonNull(
    normalizeField(account.providerAccountId),
    managedIdentity?.providerAccountId
  )
  const selectedWorkspaceId = firstNonNull(
    normalizeField(account.workspaceAccountId),
    managedIdentity?.workspaceAccountId
  )
  const emailMatches = identityFieldsAgree(selectedEmail, identity.email)
  if (
    identityContradictsSelection(
      {
        email: selectedEmail,
        providerAccountId: selectedProviderId,
        workspaceAccountId: selectedWorkspaceId
      },
      identity
    )
  ) {
    return false
  }
  if (!identityFieldMatches(selectedProviderId, identity.providerAccountId)) {
    return false
  }
  if (!identityFieldMatches(selectedWorkspaceId, identity.workspaceAccountId)) {
    return false
  }

  const hasStrongIdentity = Boolean(
    (selectedProviderId && identity.providerAccountId) ||
    (selectedWorkspaceId && identity.workspaceAccountId)
  )
  return (
    hasStrongIdentity ||
    (emailMatches && !identity.providerAccountId && !identity.workspaceAccountId)
  )
}

// Why: an unreadable managed home cannot be compared byte-for-byte, so only the
// account record itself can rule that home out as the credential's owner.
export function codexAuthCouldBelongToManagedAccount(
  runtimeAuthContents: string,
  account: CodexManagedAccount
): boolean {
  const identity = readCodexAuthIdentity(runtimeAuthContents)
  return (
    !identity ||
    !identityContradictsSelection(
      {
        email: normalizeField(account.email),
        providerAccountId: normalizeField(account.providerAccountId),
        workspaceAccountId: normalizeField(account.workspaceAccountId)
      },
      identity
    )
  )
}

// Why: the shared mirror may still hold managed credentials; only the same
// positively identified system account may ever be read back to ~/.codex.
export function codexAuthMatchesSystemDefaultIdentity(
  runtimeAuthContents: string,
  systemDefaultAuthContents: string
): boolean {
  const runtimeIdentity = readCodexAuthIdentity(runtimeAuthContents)
  const systemDefaultIdentity = readCodexAuthIdentity(systemDefaultAuthContents)
  if (!runtimeIdentity || !systemDefaultIdentity) {
    return false
  }
  if (
    systemDefaultIdentity.email &&
    runtimeIdentity.email &&
    systemDefaultIdentity.email !== runtimeIdentity.email
  ) {
    return false
  }
  if (
    !identityFieldMatches(
      systemDefaultIdentity.providerAccountId,
      runtimeIdentity.providerAccountId
    )
  ) {
    return false
  }
  if (
    !identityFieldMatches(
      systemDefaultIdentity.workspaceAccountId,
      runtimeIdentity.workspaceAccountId
    )
  ) {
    return false
  }

  const strongIdentityMatches = Boolean(
    (systemDefaultIdentity.providerAccountId && runtimeIdentity.providerAccountId) ||
    (systemDefaultIdentity.workspaceAccountId && runtimeIdentity.workspaceAccountId)
  )
  const emailMatches = Boolean(
    systemDefaultIdentity.email &&
    runtimeIdentity.email &&
    systemDefaultIdentity.email === runtimeIdentity.email
  )
  return (
    strongIdentityMatches ||
    (emailMatches && !runtimeIdentity.providerAccountId && !runtimeIdentity.workspaceAccountId)
  )
}

// Why: identity proves ownership, not ordering. Missing expiry/issue claims
// cannot prove that candidate bytes should replace the baseline credential.
export function compareCodexAuthFreshness(
  candidateAuthContents: string,
  baselineAuthContents: string
): -1 | 0 | 1 | null {
  const candidateFreshness = readFreshnessFromAuthContents(candidateAuthContents)
  const baselineFreshness = readFreshnessFromAuthContents(baselineAuthContents)
  if (candidateFreshness === null || baselineFreshness === null) {
    return null
  }
  return candidateFreshness === baselineFreshness
    ? 0
    : candidateFreshness > baselineFreshness
      ? 1
      : -1
}

export function codexAuthIsFresher(
  candidateAuthContents: string,
  baselineAuthContents: string
): boolean {
  return compareCodexAuthFreshness(candidateAuthContents, baselineAuthContents) === 1
}

export function readCodexAuthIdentity(contents: string): CodexAuthIdentity | null {
  const raw = parseJsonRecord(contents)
  if (!raw) {
    return null
  }
  const tokens = readRecordClaim(raw, 'tokens')
  const idToken = normalizeField(
    readStringClaim(tokens, 'id_token') ?? readStringClaim(tokens, 'idToken')
  )
  const payload = idToken ? parseJwtPayload(idToken) : null
  const authClaims = readRecordClaim(payload, 'https://api.openai.com/auth')
  const profileClaims = readRecordClaim(payload, 'https://api.openai.com/profile')
  // Why: normalize before the fallback chains, not after — a blank tokens.account_id
  // must fall through to the JWT claims rather than ending the chain on an empty string.
  const tokenAccountId = normalizeField(
    readStringClaim(tokens, 'account_id') ?? readStringClaim(tokens, 'accountId')
  )

  return {
    email: normalizeField(
      readStringClaim(payload, 'email') ?? readStringClaim(profileClaims, 'email')
    ),
    providerAccountId: normalizeField(
      tokenAccountId ??
        readStringClaim(authClaims, 'chatgpt_account_id') ??
        readStringClaim(payload, 'chatgpt_account_id')
    ),
    workspaceLabel: normalizeField(
      readStringClaim(authClaims, 'workspace_name') ??
        readStringClaim(profileClaims, 'workspace_name')
    ),
    workspaceAccountId: normalizeField(
      readStringClaim(authClaims, 'workspace_account_id') ??
        tokenAccountId ??
        readStringClaim(payload, 'chatgpt_account_id')
    )
  }
}

function readFreshnessFromAuthContents(contents: string): number | null {
  const raw = parseJsonRecord(contents)
  if (!raw) {
    return null
  }
  const tokens = readRecordClaim(raw, 'tokens')
  const idToken = normalizeField(
    readStringClaim(tokens, 'id_token') ?? readStringClaim(tokens, 'idToken')
  )
  const payload = idToken ? parseJwtPayload(idToken) : null
  return (
    readNumberClaim(tokens, 'expires_at') ??
    readNumberClaim(tokens, 'expiresAt') ??
    readNumberClaim(tokens, 'expiry') ??
    readNumberClaim(tokens, 'expires') ??
    readNumberClaim(payload, 'exp') ??
    readNumberClaim(payload, 'iat')
  )
}

function parseJsonRecord(contents: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(contents) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function parseJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.')
  if (parts.length < 2) {
    return null
  }
  try {
    const json = Buffer.from(parts[1], 'base64url').toString('utf-8')
    return parseJsonRecord(json)
  } catch {
    return null
  }
}

function readRecordClaim(
  value: Record<string, unknown> | null,
  key: string
): Record<string, unknown> | null {
  const claim = value?.[key]
  return claim && typeof claim === 'object' && !Array.isArray(claim)
    ? (claim as Record<string, unknown>)
    : null
}

function readStringClaim(value: Record<string, unknown> | null, key: string): string | null {
  const claim = value?.[key]
  return typeof claim === 'string' ? claim : null
}

function readNumberClaim(value: Record<string, unknown> | null, key: string): number | null {
  const claim = value?.[key]
  if (typeof claim === 'number' && Number.isFinite(claim)) {
    return claim
  }
  if (typeof claim === 'string') {
    const parsed = Number(claim)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function normalizeField(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

function firstNonNull(...values: (string | null | undefined)[]): string | null {
  return values.find((value): value is string => Boolean(value)) ?? null
}

function identityFieldMatches(selectedField: string | null, runtimeField: string | null): boolean {
  return !selectedField || Boolean(runtimeField && selectedField === runtimeField)
}

// Why: only a claim both sides carry can rule an account out — a credential with
// no identity claims (api key, PAT, bedrock) contradicts nothing. A ChatGPT
// rename leaves the record email stale, so a matching account id outranks it.
function identityContradictsSelection(
  selected: CodexAuthOwnershipIdentity,
  identity: CodexAuthOwnershipIdentity
): boolean {
  if (
    identityFieldsConflict(selected.providerAccountId, identity.providerAccountId) ||
    identityFieldsConflict(selected.workspaceAccountId, identity.workspaceAccountId)
  ) {
    return true
  }
  return (
    identityFieldsConflict(selected.email, identity.email) &&
    !identityFieldsAgree(selected.providerAccountId, identity.providerAccountId)
  )
}

function identityFieldsAgree(selectedField: string | null, runtimeField: string | null): boolean {
  return Boolean(selectedField && runtimeField && selectedField === runtimeField)
}

function identityFieldsConflict(
  selectedField: string | null,
  runtimeField: string | null
): boolean {
  return Boolean(selectedField && runtimeField && selectedField !== runtimeField)
}
