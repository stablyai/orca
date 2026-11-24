import {
  BackendDocumentAdmissionSchema,
  UsageActionSchema,
  UsageProviderSchema,
  type BackendDocumentBinding
} from '../../shared/backend/backend-service-contract'
import { BackendPortRpc, type BackendPort } from '../../shared/backend/backend-port-rpc'

export type BackendDocumentOperation = (
  binding: BackendDocumentBinding,
  method: string,
  params: unknown,
  signal: AbortSignal
) => Promise<unknown>

/** Renderer documents reach only public usage operations; control stays on main's private peer. */
export function isBackendDocumentMethod(method: string): boolean {
  const [provider, action, ...rest] = method.split(':')
  return (
    rest.length === 0 &&
    UsageProviderSchema.safeParse(provider).success &&
    UsageActionSchema.safeParse(action).success
  )
}

/** Ports main admitted for this incarnation, keyed by the document id main minted. */
export class BackendDocumentPeers {
  private readonly peers = new Map<string, BackendPortRpc>()

  constructor(
    private readonly incarnation: string,
    private readonly serve: BackendDocumentOperation
  ) {}

  admit(message: unknown, port: BackendPort): boolean {
    const admission = BackendDocumentAdmissionSchema.safeParse(message)
    if (!admission.success || admission.data.incarnation !== this.incarnation) {
      port.close()
      return false
    }
    const binding: BackendDocumentBinding = {
      ...admission.data.document,
      incarnation: this.incarnation
    }
    this.peers.get(binding.id)?.close()
    const peer = new BackendPortRpc(
      port,
      this.incarnation,
      async (method, params, signal) => {
        if (!isBackendDocumentMethod(method)) {
          throw new Error('This operation is not available to Orca windows.')
        }
        return this.serve(binding, method, params, signal)
      },
      () => {
        if (this.peers.get(binding.id) === peer) {
          this.peers.delete(binding.id)
        }
      }
    )
    this.peers.set(binding.id, peer)
    return true
  }

  retire(documentId: string): void {
    this.peers.get(documentId)?.close()
  }

  closeAll(): void {
    for (const peer of this.peers.values()) {
      peer.close()
    }
  }
}
