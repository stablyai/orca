import type {
  PtyOwnershipTransferDestinationAdapter,
  PtyOwnershipTransferDestinationAdapterOptions,
  PtyOwnershipTransferDestinationSnapshot
} from '../../../shared/pty-ownership-transfer-destination-adapter'
import type { Store } from '../loading-store/store'
export type { PtyOwnershipTransferDestinationSnapshot } from '../../../shared/pty-ownership-transfer-destination-adapter'
import type { PtyOwnershipTransferDestinationOutputDelivery } from './pty-ownership-transfer-destination-output-sink'
import type { PtyOwnershipTransferDurableSurfaceTarget } from './pty-ownership-transfer-surface-publication'

type DestinationSurfaceStore = Pick<
  Store,
  | 'getProfileStorageDirectory'
  | 'inspectPtyOwnershipTransferSurface'
  | 'publishPtyOwnershipTransferSurface'
> &
  Partial<
    Pick<
      Store,
      'checkpointPtyOwnershipTransferTerminalModel' | 'preparePtyOwnershipTransferCatalogAdmission'
    >
  >

export type PtyOwnershipTransferDestinationRuntimeOptions = Readonly<{
  runtimeId: string
  /** Host implementation opt-in, never client-supplied capability evidence. */
  catalogPublicationVersion?: 1
  store: DestinationSurfaceStore
  publishPostCommitOutput: PtyOwnershipTransferDestinationAdapterOptions['publishPostCommitOutput']
  /** Optional strict sink acknowledgement; omission retains the legacy callback path. */
  publishPostCommitOutputAcknowledged?: PtyOwnershipTransferDestinationOutputDelivery
  inputIds?: number
}>

export type PreparedPtyOwnershipTransferDestination = Readonly<{
  adapter: PtyOwnershipTransferDestinationAdapter
  snapshot: PtyOwnershipTransferDestinationSnapshot
}>

export type RecoveredPtyOwnershipTransferDestination = Readonly<{
  bridgeId: string
  destinationRuntimeId: string
  phase: PtyOwnershipTransferDestinationSnapshot['phase']
  adapter: PtyOwnershipTransferDestinationAdapter
  snapshot: PtyOwnershipTransferDestinationSnapshot
}>

export class PtyOwnershipTransferWorkspaceSurfaceTarget implements PtyOwnershipTransferDurableSurfaceTarget {
  constructor(private readonly store: DestinationSurfaceStore) {}

  inspectDurablePublication: PtyOwnershipTransferDurableSurfaceTarget['inspectDurablePublication'] =
    (request) => this.store.inspectPtyOwnershipTransferSurface(request)

  publishDurably: PtyOwnershipTransferDurableSurfaceTarget['publishDurably'] = (request) => {
    this.store.publishPtyOwnershipTransferSurface(request)
  }
}
