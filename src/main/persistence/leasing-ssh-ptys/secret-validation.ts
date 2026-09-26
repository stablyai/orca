export function isLegacyOpenCodeSessionCookie(value: string): boolean {
  const trimmed = value.trim()
  return (
    trimmed.startsWith('Fe26.2**') ||
    trimmed.split(';').some((pair) => /^(?:auth|__Host-auth)=\S+$/i.test(pair.trim()))
  )
}

// OpenCode Go keys are opaque bearer tokens; the console issues `sk-`
// (legacy) and `oc_sk_` (new console) prefixes.
export function isLegacyOpenCodeGoApiKey(value: string): boolean {
  const trimmed = value.trim()
  return /^(?:oc_)?sk[-_][A-Za-z0-9._-]+$/.test(trimmed)
}

export function isLegacySshPtyOwnerLease(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}
