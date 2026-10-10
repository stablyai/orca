/**
 * An inert stand-in for `ssh-previous-relay-terminals`, for session tests whose deploy mocks carry
 * no host details: no older relay is ever found, so reattach keeps its ordinary not-found path.
 */
const noCensus = { endpoints: [], status: 'complete' as const, bridgeable: false }

export const startPreviousRelayCensus = async (): Promise<typeof noCensus> => noCensus
export const previousRelayCensus = async (): Promise<typeof noCensus> => noCensus
export const clearPreviousRelayCensus = (): void => {}
export const isReattachHeldByPreviousRelay = async (): Promise<boolean> => false
export const previousRelayMayHoldTerminals = async (): Promise<boolean> => false
