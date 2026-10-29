export const SPLICE_STATE = {
  PRE_AUTH_ADMITTED: 'pre-auth-admitted',
  CREDENTIAL_LEASE_RESERVED: 'credential-lease-reserved',
  HOST_NOTIFIED: 'host-notified',
  ATTACH_PENDING: 'attach-pending',
  HOST_ATTACHED: 'host-attached',
  CLIENT_ACKNOWLEDGED: 'client-acknowledged',
  SPLICED: 'spliced',
  E2EE_CONFIRMABLE: 'e2ee-confirmable',
  TEARDOWN: 'teardown'
} as const

export type SpliceState = (typeof SPLICE_STATE)[keyof typeof SPLICE_STATE]

export const SPLICE_FORWARD_TRANSITIONS: Readonly<Record<SpliceState, readonly SpliceState[]>> = {
  [SPLICE_STATE.PRE_AUTH_ADMITTED]: [SPLICE_STATE.CREDENTIAL_LEASE_RESERVED, SPLICE_STATE.TEARDOWN],
  [SPLICE_STATE.CREDENTIAL_LEASE_RESERVED]: [SPLICE_STATE.HOST_NOTIFIED, SPLICE_STATE.TEARDOWN],
  [SPLICE_STATE.HOST_NOTIFIED]: [SPLICE_STATE.ATTACH_PENDING, SPLICE_STATE.TEARDOWN],
  [SPLICE_STATE.ATTACH_PENDING]: [SPLICE_STATE.HOST_ATTACHED, SPLICE_STATE.TEARDOWN],
  [SPLICE_STATE.HOST_ATTACHED]: [SPLICE_STATE.CLIENT_ACKNOWLEDGED, SPLICE_STATE.TEARDOWN],
  [SPLICE_STATE.CLIENT_ACKNOWLEDGED]: [SPLICE_STATE.SPLICED, SPLICE_STATE.TEARDOWN],
  [SPLICE_STATE.SPLICED]: [SPLICE_STATE.E2EE_CONFIRMABLE, SPLICE_STATE.TEARDOWN],
  [SPLICE_STATE.E2EE_CONFIRMABLE]: [SPLICE_STATE.TEARDOWN],
  [SPLICE_STATE.TEARDOWN]: []
}

export function canAdvanceSplice(from: SpliceState, to: SpliceState): boolean {
  return SPLICE_FORWARD_TRANSITIONS[from].includes(to)
}

export function mayAcknowledgeClient(state: SpliceState, forwardingHandlersInstalled: boolean): boolean {
  // Why: success before both forwarding handlers exist can strand a client on a fake splice.
  return state === SPLICE_STATE.HOST_ATTACHED && forwardingHandlersInstalled
}
