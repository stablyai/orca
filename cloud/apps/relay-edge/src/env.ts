import type { HostRelay } from './host-relay'
import type { SpliceRelay } from './splice-relay'

export interface Env {
  HOST_RELAY: DurableObjectNamespace<HostRelay>
  SPLICE_RELAY: DurableObjectNamespace<SpliceRelay>
  // Flood guard per splice direction: close 4429 if more than this many bytes reach a peer that
  // has sent nothing within the window. 0 disables.
  SPLICE_SILENT_BYTES_MAX?: string
  SPLICE_SILENT_WINDOW_MS?: string
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
