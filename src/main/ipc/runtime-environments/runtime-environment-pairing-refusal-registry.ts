/**
 * Who answers a server refusing this desktop's token, registered by the IPC layer so the status
 * owner and the shared control socket reach it without importing the SSH tunnel machinery.
 */
export type RefusedPairingRecovery = (environmentId: string) => Promise<'built' | 'repaired'> | null
export type SharedControlRefusalHandler = (
  environmentId: string
) => Promise<'retry' | 'stop'> | null

let recovery: RefusedPairingRecovery = () => null
let sharedControlHandler: SharedControlRefusalHandler = () => null
let connectRequested: (environmentId: string) => void = () => {}

export function setRefusedPairingHandlers(handlers: {
  recover: RefusedPairingRecovery
  sharedControl: SharedControlRefusalHandler
  connectRequested: (environmentId: string) => void
}): void {
  recovery = handlers.recover
  sharedControlHandler = handlers.sharedControl
  connectRequested = handlers.connectRequested
}

/** An explicit Connect is the user asking again, so a recently failed re-pair must not answer it. */
export function noteRuntimeEnvironmentConnectRequested(environmentId: string): void {
  connectRequested(environmentId)
}

/** Null when nobody can pair this server again, so the refusal stands. */
export function recoverRefusedPairing(environmentId: string): Promise<'built' | 'repaired'> | null {
  return recovery(environmentId)
}

/** A promise means the handler owns recovery of the refused socket. */
export function handleSharedControlRefusal(
  environmentId: string
): Promise<'retry' | 'stop'> | null {
  return sharedControlHandler(environmentId)
}
