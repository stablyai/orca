import type { PairingRelay } from '../../../shared/mobile-relay-pairing-offer'
import type { RelayDeviceBinding } from './relay-revoke-outbox'

// Why: a shared-DB stall lasts 5-7 s; a pairing mint waits out the retries that
// cover it rather than showing the user an error a moment later retry fixes.
export const PAIRING_RELAY_GRACE_MS = 15_000

// Deterministic cell refusals; anything else (a timeout, a DB error the cell
// forwards as its message) may clear on a single retry.
const TERMINAL_INVITE_ERRORS = new Set([
  'authorization_expired',
  'rate_limit_exceeded',
  'assignment_not_found'
])

export function isRetryableInviteError(error: unknown): boolean {
  return error instanceof Error && !TERMINAL_INVITE_ERRORS.has(error.message)
}

type InviteBroker = {
  readonly hostId: string
  readonly ownerIdentityKey: string
  createPairingRelay(relayDeviceId: string): Promise<PairingRelay>
}

async function mint(
  broker: InviteBroker,
  relayDeviceId: string
): Promise<{ relay: PairingRelay; binding: RelayDeviceBinding }> {
  const relay = await broker.createPairingRelay(relayDeviceId)
  return {
    relay,
    binding: {
      relayHostId: broker.hostId,
      relayDeviceId,
      ownerIdentityKey: broker.ownerIdentityKey,
      inviteExpiresAt: relay.inviteExpiresAt
    }
  }
}

// A retried invite-create is safe: the cell invalidates the device's earlier invite.
export async function createPairingRelayWithRetry(input: {
  relayDeviceId: string
  acquire: (graceMs: number) => Promise<InviteBroker>
  beforeRetry: () => void
}): Promise<{ relay: PairingRelay; binding: RelayDeviceBinding }> {
  const deadline = Date.now() + PAIRING_RELAY_GRACE_MS
  // Outside the try: no live control within the grace is final, not a retry.
  const broker = await input.acquire(PAIRING_RELAY_GRACE_MS)
  try {
    return await mint(broker, input.relayDeviceId)
  } catch (error) {
    if (!isRetryableInviteError(error)) {
      throw error
    }
  }
  input.beforeRetry()
  return await mint(await input.acquire(Math.max(0, deadline - Date.now())), input.relayDeviceId)
}
