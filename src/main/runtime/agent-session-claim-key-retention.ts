// How long a retired HMAC claim key stays verifiable.
//
// A rotation must never strand a running agent: the lease it was granted under
// was signed by the old key, so that key has to keep verifying for as long as a
// session could plausibly still be holding it.

export type RetiredAgentSessionClaimKey = { keyId: string; retiredAt: number }

export const AGENT_SESSION_CLAIM_KEY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

export function isAgentSessionClaimKeyVerifiable(
  retiredKeys: readonly RetiredAgentSessionClaimKey[],
  keyId: string,
  now: number
): boolean {
  const retired = retiredKeys.find((entry) => entry.keyId === keyId)
  return !retired || now - retired.retiredAt <= AGENT_SESSION_CLAIM_KEY_RETENTION_MS
}

/** Records the retirement and drops every key that has aged out of the window. */
export function retireAgentSessionClaimKey(
  retiredKeys: readonly RetiredAgentSessionClaimKey[],
  keyId: string,
  now: number
): RetiredAgentSessionClaimKey[] {
  const retained = retiredKeys.some((entry) => entry.keyId === keyId)
    ? [...retiredKeys]
    : [...retiredKeys, { keyId, retiredAt: now }]
  return retained.filter((entry) => now - entry.retiredAt <= AGENT_SESSION_CLAIM_KEY_RETENTION_MS)
}
