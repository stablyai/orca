export const RELAY_CLOSE_CODE = {
  BAD_OUTER_CREDENTIAL: 4401,
  HOST_OFFLINE: 4404,
  PEER_DROPPED: 4408,
  WRONG_CELL: 4409,
  LIMIT_EXCEEDED: 4429,
  DRAINING: 4503
} as const

export type RelayCloseCode = (typeof RELAY_CLOSE_CODE)[keyof typeof RELAY_CLOSE_CODE]

// Mirror src/shared/mobile-relay-close-codes.ts; these refine phone close codes, while RELAY_HOST_CLOSE_REASON describes host controls.
export const RELAY_PHONE_CLOSE_REASON = {
  // Live control with missed hostAttachDeadlineMs: phone retries same cell once quickly.
  HOST_ATTACH_TIMEOUT: 'attach-timeout'
} as const

export type RelayPhoneCloseReason =
  (typeof RELAY_PHONE_CLOSE_REASON)[keyof typeof RELAY_PHONE_CLOSE_REASON]
