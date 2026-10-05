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
  liveCredentialsJson: string | null,
  options: { preserveMissingLiveFields?: boolean } = {}
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
    } else if (targetHasKey && !options.preserveMissingLiveFields) {
      delete merged[key]
      changed = true
    }
  }
  return changed ? JSON.stringify(merged) : targetCredentialsJson
}
