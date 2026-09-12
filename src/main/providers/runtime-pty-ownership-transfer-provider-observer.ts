import type { IPtyProvider } from './pty-provider-contract'
import type { RuntimePtyOwnershipTransferSourceAdapter } from './runtime-pty-ownership-transfer-source-adapter'

type RuntimePtyOwnershipTransferObservedProvider = Pick<IPtyProvider, 'onData' | 'onExit'>

/** Incarnation-fenced provider events feeding the durable runtime source journal. */
export class RuntimePtyOwnershipTransferProviderObserver {
  private unsubscribers: (() => void)[]

  constructor(
    provider: RuntimePtyOwnershipTransferObservedProvider,
    adapter: Pick<RuntimePtyOwnershipTransferSourceAdapter, 'observeOutput' | 'observeExit'>
  ) {
    this.unsubscribers = [
      provider.onData((event) => {
        if (!event.incarnationId) {
          return
        }
        adapter.observeOutput({
          terminalId: event.id,
          incarnationId: event.incarnationId,
          data: event.data,
          ...(event.seq === undefined
            ? {}
            : {
                emissionKey: `${event.incarnationId}:${event.seq}:${event.sequenceChars ?? event.data.length}`
              })
        })
      }),
      provider.onExit((event) => {
        if (!event.incarnationId) {
          return
        }
        adapter.observeExit({
          terminalId: event.id,
          incarnationId: event.incarnationId,
          code: event.code
        })
      })
    ]
  }

  dispose(): void {
    for (const unsubscribe of this.unsubscribers.splice(0)) {
      unsubscribe()
    }
  }
}
