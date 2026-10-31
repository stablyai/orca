import { RuntimeRpcWebSocketDispatch } from './runtime-rpc-websocket-dispatch'
import { publishHostDescriptor } from '../host-descriptor'
import type { RpcTransport } from '../rpc/transport'

export class RuntimeRpcRetirement extends RuntimeRpcWebSocketDispatch {
  protected retireRuntimeRpcTransports(): Promise<unknown[]> {
    if (this.runtimeRpcRetirement) {
      return this.runtimeRpcRetirement
    }
    const operation = Promise.resolve().then(async () => {
      const errors: unknown[] = []
      this.transports = []
      for (const cleanup of [
        () => {
          this.metadataOwnershipWatch?.stop()
          this.metadataOwnershipWatch = null
        },
        () => {
          if (this.hostDescriptor) {
            publishHostDescriptor(this.runtime.getRuntimeId(), null)
          }
        },
        () => {
          this.mobileSocketWiring?.dispose()
          this.mobileSocketWiring = null
        },
        () => {
          this.detachPairedServerRows?.()
          this.detachPairedServerRows = null
          this.detachWebSocketWiring = null
        }
      ]) {
        try {
          cleanup()
        } catch (error) {
          errors.push(error)
        }
      }
      const transports: RpcTransport[] = this.activeTransports.slice()
      const results = await Promise.allSettled(
        transports.map(async (transport) => {
          await transport.stop()
          const index = this.activeTransports.indexOf(transport)
          if (index !== -1) {
            this.activeTransports.splice(index, 1)
          }
        })
      )
      for (const result of results) {
        if (result.status === 'rejected') {
          errors.push(result.reason)
        }
      }
      // Direct auth may update lastSeen while the independently addressed transports close.
      try {
        this.deviceRegistry?.flushPendingLastSeen()
      } catch (error) {
        errors.push(error)
      }
      return errors
    })
    this.runtimeRpcRetirement = operation
    return operation
  }
}
