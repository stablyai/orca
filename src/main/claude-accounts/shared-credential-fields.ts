import { isDeepStrictEqual } from 'node:util'

export const SHARED_CLAUDE_CREDENTIAL_KEYS = [
  'mcpOAuth',
  'mcpOAuthClientConfig',
  'mcpXaaIdp',
  'mcpXaaIdpConfig',
  'pluginSecrets'
] as const

function parseCredentialObject(credentialsJson: string | null): Record<string, unknown> | null {
  if (!credentialsJson) {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(credentialsJson)
  } catch {
    return null
  }
  return isCredentialObject(parsed) ? parsed : null
}

function isCredentialObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function stripSharedClaudeCredentialFields(credentialsJson: string): string {
  const credential = parseCredentialObject(credentialsJson)
  if (!credential) {
    return credentialsJson
  }
  let changed = false
  for (const key of SHARED_CLAUDE_CREDENTIAL_KEYS) {
    if (Object.hasOwn(credential, key)) {
      delete credential[key]
      changed = true
    }
  }
  return changed ? JSON.stringify(credential) : credentialsJson
}

// Shared connector state follows the live runtime, including revocations, rather than frozen account snapshots.
export function mergeSharedClaudeCredentialFields(
  targetCredentialsJson: string,
  liveCredentialsJson: string | null
): string {
  const target = parseCredentialObject(targetCredentialsJson)
  const live = parseCredentialObject(liveCredentialsJson)
  if (
    !target ||
    !live ||
    (Object.hasOwn(target, 'claudeAiOauth') && !isCredentialObject(target.claudeAiOauth))
  ) {
    return targetCredentialsJson
  }

  let changed = false
  const merged: Record<string, unknown> = { ...target }
  for (const key of SHARED_CLAUDE_CREDENTIAL_KEYS) {
    const targetHasKey = Object.hasOwn(target, key)
    if (Object.hasOwn(live, key)) {
      if (!targetHasKey || JSON.stringify(live[key]) !== JSON.stringify(target[key])) {
        merged[key] = live[key]
        changed = true
      }
    } else if (targetHasKey) {
      delete merged[key]
      changed = true
    }
  }
  return changed ? JSON.stringify(merged) : targetCredentialsJson
}

type CredentialField = { present: boolean; value: unknown }

function credentialField(record: Record<string, unknown>, key: string): CredentialField {
  const present = Object.hasOwn(record, key)
  return { present, value: present ? record[key] : undefined }
}

function resolveCredentialField(
  candidates: CredentialField[],
  baseline: CredentialField | null
): CredentialField {
  const changes = candidates.filter((candidate) =>
    baseline === null ? candidate.present : !isDeepStrictEqual(candidate, baseline)
  )
  const first = changes[0]
  if (first && changes.some((candidate) => !isDeepStrictEqual(candidate, first))) {
    throw new Error(
      'Cannot switch Claude accounts: live connector credentials conflict; existing authorizations were preserved'
    )
  }
  return first ?? baseline ?? { present: false, value: undefined }
}

function resolveServerGrants(
  sources: Record<string, unknown>[],
  baseline: Record<string, unknown> | null,
  key: string
): CredentialField | null {
  const fields = sources.map((source) => credentialField(source, key))
  const previous = baseline === null ? null : credentialField(baseline, key)
  if (
    fields.some((field) => field.present && !isCredentialObject(field.value)) ||
    (previous?.present && !isCredentialObject(previous.value))
  ) {
    return null
  }
  const maps = fields.map((field) => (isCredentialObject(field.value) ? field.value : {}))
  const previousMap =
    previous === null ? null : isCredentialObject(previous.value) ? previous.value : {}
  const names = new Set([
    ...maps.flatMap((map) => Object.keys(map)),
    ...Object.keys(previousMap ?? {})
  ])
  const entries: [string, unknown][] = []
  for (const name of names) {
    // Keep a server's access/refresh token pair atomic while combining independent server updates.
    const grant = resolveCredentialField(
      maps.map((map) => credentialField(map, name)),
      previousMap === null ? null : credentialField(previousMap, name)
    )
    if (grant.present) {
      entries.push([name, grant.value])
    }
  }
  const present =
    entries.length > 0 ||
    (fields.some((field) => field.present) &&
      !(baseline !== null && fields.some((field) => !field.present)))
  return { present, value: present ? Object.fromEntries(entries) : undefined }
}

export function reconcileSharedClaudeCredentialFields(
  liveCredentials: string[],
  lastWrittenCredentials: string | null
): string {
  const sources = liveCredentials.map((credentials) => {
    const parsed = parseCredentialObject(credentials)
    if (!parsed) {
      throw new Error('Cannot preserve malformed Claude runtime credentials')
    }
    return parsed
  })
  if (sources.length === 0) {
    return '{}'
  }
  const baseline = parseCredentialObject(lastWrittenCredentials)
  const entries: [string, unknown][] = []
  for (const key of SHARED_CLAUDE_CREDENTIAL_KEYS) {
    const field =
      (key === 'mcpOAuth' || key === 'mcpOAuthClientConfig'
        ? resolveServerGrants(sources, baseline, key)
        : null) ??
      resolveCredentialField(
        sources.map((source) => credentialField(source, key)),
        baseline === null ? null : credentialField(baseline, key)
      )
    if (field.present) {
      entries.push([key, field.value])
    }
  }
  return JSON.stringify(Object.fromEntries(entries))
}
