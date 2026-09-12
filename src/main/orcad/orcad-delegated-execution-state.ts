import type { OrcadDelegatedConnectionOptions } from './orcad-delegated-connection-contract'
import type { OrcadDelegatedTransferClient } from './orcad-delegated-transfer-client'
import type {
  PtyOwnershipTransferDestinationClaim,
  PtyOwnershipTransferDestinationProof
} from '../../shared/pty-ownership-transfer-destination-claim'

export function createOrcadDelegatedExecutionState(
  options: Pick<
    OrcadDelegatedConnectionOptions,
    'adapter' | 'identity' | 'signal' | 'timeoutMs' | 'onError' | 'onExecutionState'
  > & {
    client: OrcadDelegatedTransferClient
    proof: PtyOwnershipTransferDestinationProof
    claim: PtyOwnershipTransferDestinationClaim
    isActive: () => boolean
    isReady: () => boolean
    deliverExit: () => boolean
    invalidate: () => unknown
  }
) {
  const notify = () => {
    try {
      options.onExecutionState?.(options.identity, options.claim)
    } catch (error) {
      try {
        options.onError(error)
      } catch {
        /* Diagnostics cannot prevent fencing. */
      }
    }
  }
  const refresh = async (reportFailure = false) => {
    if (!options.isActive()) {
      throw new Error('orcad_delegated_connection_stale')
    }
    try {
      const status = await options.client.status(options.proof, {
        signal: options.signal,
        timeoutMs: options.timeoutMs
      })
      if (!options.isActive()) {
        throw new Error('orcad_delegated_connection_stale')
      }
      const snapshot = options.adapter.acceptDelegatedExecutionStatus(status)
      notify()
      options.deliverExit()
      return snapshot
    } catch (error) {
      if (options.isActive()) {
        if (reportFailure) {
          try {
            options.onError(error)
          } catch {
            /* Diagnostics cannot prevent fencing. */
          }
        }
        options.invalidate()
      }
      throw error
    }
  }
  let initialStarted = false
  return {
    refresh: () => refresh(),
    disconnect: () => {
      options.adapter.markDelegatedExecutionUnverifiable(options.claim)
      notify()
    },
    wake: () => {
      if (initialStarted || !options.isActive() || !options.isReady()) {
        return
      }
      initialStarted = true
      void refresh(true).catch(() => {})
    }
  }
}
