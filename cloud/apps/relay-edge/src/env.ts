export interface Env {
  HOST_RELAY: DurableObjectNamespace
  RELAY_JWKS: string
  RELAY_JWT_AUDIENCE: string
  PING_INTERVAL_MS: string
  SILENCE_TIMEOUT_MS: string
  ORPHAN_GRACE_MS: string
  // Spike-only stub: comma-separated base64url sha256 hashes of accepted phone resume tokens.
  SPIKE_RESUME_TOKEN_HASHES?: string
  SPIKE_ADMIN?: string
}

export type EdgeClaims = {
  userId: string
  profileId: string
  organizationId: string
  relayHostId: string
  exp: number
}
