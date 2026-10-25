import type { CodexManagedAccount } from '../../shared/managed-account-types'

export type CodexAuthIdentity = {
  email: string | null
  providerAccountId: string | null
  workspaceLabel: string | null
  workspaceAccountId: string | null
}

type CodexAuthOwnershipIdentity = Omit<CodexAuthIdentity, 'workspaceLabel'>

// Stale shared-home PTYs can write after a switch; require positive identity before read-back.
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

// An unreadable home remains a possible owner unless its account record contradicts the credential.
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

// Only positively matched system credentials may be read back from the shared mirror to ~/.codex.
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

// Ownership alone cannot prove freshness; missing expiry and issue claims leave ordering unknown.
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
  // Normalize blank account IDs before fallback because empty strings are not nullish.
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
    workspaceLabel:
      normalizeField(readStringClaim(authClaims, 'workspace_name')) ??
      normalizeField(readStringClaim(profileClaims, 'workspace_name')) ??
      readPlanWorkspaceLabel(authClaims),
    workspaceAccountId: normalizeField(
      readStringClaim(authClaims, 'workspace_account_id') ??
        tokenAccountId ??
        readStringClaim(payload, 'chatgpt_account_id')
    )
  }
}

function readPlanWorkspaceLabel(authClaims: Record<string, unknown> | null): string | null {
  // Codex tokens commonly omit workspace_name but identify the account's plan.
  switch (normalizeField(readStringClaim(authClaims, 'chatgpt_plan_type'))?.toLowerCase()) {
    case 'free':
      return 'Personal (Free)'
    case 'go':
      return 'Personal (Go)'
    case 'plus':
      return 'Personal (Plus)'
    case 'pro':
      return 'Personal (Pro)'
    case 'team':
      return 'Team'
    case 'business':
      return 'Business'
    case 'enterprise':
      return 'Enterprise'
    case 'edu':
      return 'Education'
    case undefined:
    default:
      return null
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

// Only shared claims can conflict; matching provider IDs outweigh email changes after a rename.
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
