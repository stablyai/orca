import type { PtyOwnershipTransferIdentity } from '../../shared/pty-ownership-transfer-journal'
import type { PtyOwnershipTransferDestinationAdapter } from '../../shared/pty-ownership-transfer-destination-adapter'
import type { PtyOwnershipTransferDestinationFileStore } from '../persistence/pty-ownership-transfer/pty-ownership-transfer-destination-file-store'
import type { PtyOwnershipTransferDestinationOutputOutbox } from '../persistence/pty-ownership-transfer/pty-ownership-transfer-destination-output-outbox'
import type { installOrcadDelegatedOutputReceiver } from './orcad-delegated-output-receiver'
import type { OrcadDelegatedExitEvent } from './orcad-delegated-exit-delivery'
import type { PtyProviderBufferSnapshot } from '../providers/pty-provider-contract'
import type { PtyOwnershipTransferDestinationClaim } from '../../shared/pty-ownership-transfer-destination-claim'

export type OrcadDelegatedConnectionOptions = {
  identity: PtyOwnershipTransferIdentity
  store: PtyOwnershipTransferDestinationFileStore
  adapter: PtyOwnershipTransferDestinationAdapter
  outbox: PtyOwnershipTransferDestinationOutputOutbox
  signal: AbortSignal
  onError: (error: unknown) => void
  onExit?: (event: OrcadDelegatedExitEvent) => void
  onExecutionState?: (
    identity: PtyOwnershipTransferIdentity,
    claim: PtyOwnershipTransferDestinationClaim
  ) => void
  initializeModel?: (signal: AbortSignal) => Promise<void>
  providerModel?: {
    snapshot: (options?: { scrollbackRows?: number }) => Promise<PtyProviderBufferSnapshot | null>
    sequence: () => number
  }
  createClaimId?: () => string
  timeoutMs?: number
  prepareModelFrame?: Parameters<typeof installOrcadDelegatedOutputReceiver>[0]['prepareModelFrame']
}
