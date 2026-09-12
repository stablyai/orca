import type {
  PtyOwnershipTransferOutputFrame,
  PtyOwnershipTransferWireIdentity
} from '../../shared/pty-ownership-transfer-wire'
import type { SshPtyOwnershipTransferSourceRange } from '../providers/ssh-pty-ownership-transfer-output-assembler'
import type { PtyOwnershipTransferDestinationRuntimeRegistry } from '../persistence/pty-ownership-transfer/pty-ownership-transfer-destination-runtime'

type DestinationOutputRegistry = Pick<
  PtyOwnershipTransferDestinationRuntimeRegistry,
  'acceptPostCommitOutputAfterAttachment' | 'stagePostCommitOutput'
>

type OutputDeliveryOptions = Readonly<{
  destination: DestinationOutputRegistry
  waitForModelCheckpoints: (ranges: readonly SshPtyOwnershipTransferSourceRange[]) => Promise<void>
  settleSourceRange: (range: SshPtyOwnershipTransferSourceRange) => boolean
}>

/** Serializes complete transfer frames through the durable model and attachment barriers. */
export class SshPtyOwnershipTransferOutputDelivery {
  private readonly deliveryByBridge = new Map<string, Promise<void>>()

  constructor(private readonly options: OutputDeliveryOptions) {}

  accept = async (
    identity: PtyOwnershipTransferWireIdentity,
    frame: PtyOwnershipTransferOutputFrame,
    sourceRanges: readonly SshPtyOwnershipTransferSourceRange[]
  ): Promise<void> => {
    this.options.destination.stagePostCommitOutput(identity, frame)
    const prior = this.deliveryByBridge.get(identity.bridgeId)
    const delivery = (prior ?? Promise.resolve()).then(async () => {
      await this.options.waitForModelCheckpoints(sourceRanges)
      await this.options.destination.acceptPostCommitOutputAfterAttachment(identity, frame)
      const settled = new Set<string>()
      for (const range of sourceRanges) {
        if (settled.has(range.spanId)) {
          continue
        }
        settled.add(range.spanId)
        this.options.settleSourceRange(range)
      }
    })
    this.deliveryByBridge.set(identity.bridgeId, delivery)
    const cleanup = (): void => {
      if (this.deliveryByBridge.get(identity.bridgeId) === delivery) {
        this.deliveryByBridge.delete(identity.bridgeId)
      }
    }
    void delivery.then(cleanup, cleanup)
    await delivery
  }
}
