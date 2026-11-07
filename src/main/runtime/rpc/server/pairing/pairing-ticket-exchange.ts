import type { DeviceEntry } from './device-entry'
import { devicePrincipalOf } from './device-principal'

/**
 * Single-use pairing tickets. A client signed in with the pairing token proposes its own
 * replacement; the pairing token keeps working until the client first signs in with the
 * replacement, so a lost reply never strands it. That sign-in retires the pairing token.
 */
// Clients exchange right after their first sign-in. A code that has worked as a plain token for
// longer may already be in use by several older clients, so it is never retired after that.
export const TICKET_EXCHANGE_WINDOW_MS = 10 * 60_000

/** Within the pairing window: first sighting known and recent. Unknown means it already served as a token. */
export function isWithinTicketWindow(row: DeviceEntry, at: number): boolean {
  return (
    row.ticketFirstSeenAt !== undefined && at - row.ticketFirstSeenAt <= TICKET_EXCHANGE_WINDOW_MS
  )
}

export class PairingTicketExchangeError extends Error {
  constructor(
    readonly code:
      | 'device_not_found'
      | 'not_a_ticket'
      | 'delegated_device'
      | 'ticket_already_exchanged'
      | 'device_token_in_use'
      | 'ticket_window_closed'
      | 'ticket_exchange_pending'
  ) {
    super(code)
  }
}

export function planTicketExchange(
  devices: readonly DeviceEntry[],
  deviceId: string,
  presentedToken: string,
  exchangeToken: string,
  now = Date.now()
): DeviceEntry[] {
  const row = devices.find((device) => device.deviceId === deviceId)
  if (!row) {
    throw new PairingTicketExchangeError('device_not_found')
  }
  // Parent desktops own relayed children's credentials.
  if (row.parentDeviceId !== undefined) {
    throw new PairingTicketExchangeError('delegated_device')
  }
  if (row.ticket !== true || row.credentialKind !== undefined || row.token === undefined) {
    throw new PairingTicketExchangeError('not_a_ticket')
  }
  // Only the pairing token may propose; a client already on its replacement has nothing to exchange.
  if (row.token !== presentedToken) {
    throw new PairingTicketExchangeError('ticket_already_exchanged')
  }
  // A resent proposal (same token) is idempotent.
  if (row.exchangeToken === exchangeToken) {
    return [...devices]
  }
  // The first client to propose keeps its claim: a second one keeps using the code and is
  // refused only once the first signs in with its token (single use), never the other way round.
  if (row.exchangeToken !== undefined) {
    throw new PairingTicketExchangeError('ticket_exchange_pending')
  }
  if (!isWithinTicketWindow(row, now)) {
    throw new PairingTicketExchangeError('ticket_window_closed')
  }
  if (
    devices.some(
      (device) => device.token === exchangeToken || device.exchangeToken === exchangeToken
    )
  ) {
    throw new PairingTicketExchangeError('device_token_in_use')
  }
  return devices.map((device) => (device === row ? { ...row, exchangeToken } : device))
}

/** The row after its client first signed in with the replacement. */
export function promoteExchangedTicket(row: DeviceEntry & { exchangeToken: string }): DeviceEntry {
  const { exchangeToken, ticket: _ticket, ...rest } = row
  return {
    ...rest,
    token: exchangeToken,
    // Keep orchestration ownership and per-client state keyed to the pairing.
    callerFingerprint: devicePrincipalOf(row).callerFingerprint,
    // Sockets still on the pairing token fail their next request.
    credentialRevision: (row.credentialRevision ?? 0) + 1
  }
}

export function isExchangeSignIn(
  device: DeviceEntry,
  token: string
): device is DeviceEntry & { exchangeToken: string } {
  return device.exchangeToken !== undefined && device.exchangeToken === token
}
