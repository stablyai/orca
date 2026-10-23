export const RELAY_CLOSE_CODE = {
  BAD_OUTER_CREDENTIAL: 4401,
  HOST_OFFLINE: 4404,
  PEER_DROPPED: 4408,
  WRONG_CELL: 4409,
  LIMIT_EXCEEDED: 4429,
  DRAINING: 4503
} as const

export type RelayCloseCode = (typeof RELAY_CLOSE_CODE)[keyof typeof RELAY_CLOSE_CODE]

// Mirror of MOBILE_RELAY_PHONE_CLOSE_REASON in src/shared/mobile-relay-close-codes.ts
// in the Orca app repo half. Close reasons on a phone socket that refine its close
// code; not RELAY_HOST_CLOSE_REASON, which names host control-socket closes.
export const RELAY_PHONE_CLOSE_REASON = {
  // A HOST_OFFLINE sent while the host's control looked alive but its data link
  // missed hostAttachDeadlineMs; the phone redials the same cell once, quickly.
  HOST_ATTACH_TIMEOUT: 'attach-timeout'
} as const

export type RelayPhoneCloseReason =
  (typeof RELAY_PHONE_CLOSE_REASON)[keyof typeof RELAY_PHONE_CLOSE_REASON]
