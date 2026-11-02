import { BrowserClientPageMetadataAck } from '../../shared/browser-client-page-metadata-protocol'
import { RemoteRuntimeClientError } from '../../shared/remote-runtime/remote-runtime-client-error'
import type { RuntimeRpcResponse } from '../../shared/runtime-rpc-envelope'

export type BrowserClientPageMetadataSender = {
  sendPageMetadataRequest(params: unknown, timeoutMs: number): Promise<RuntimeRpcResponse<unknown>>
}

// Match longer lease request budgets: an early metadata timeout would tear down the shared lease.
export const BROWSER_CLIENT_PAGE_METADATA_REQUEST_TIMEOUT_MS = 30_000

/** Page metadata must use the lease’s own connection ID to pass runtime admission. */
export class BrowserClientPageMetadataTransport {
  private sender: BrowserClientPageMetadataSender | null = null

  constructor(private readonly observeCurrentUrl?: (params: unknown) => void) {}

  bind(sender: BrowserClientPageMetadataSender): void {
    this.sender = sender
  }

  unbind(sender: BrowserClientPageMetadataSender): void {
    if (this.sender === sender) {
      this.sender = null
    }
  }

  async publish(params: unknown): Promise<{ accepted: boolean }> {
    // Record user navigation even when the lease cannot publish it.
    this.observeCurrentUrl?.(params)
    const sender = this.sender
    if (!sender) {
      throw new RemoteRuntimeClientError(
        'remote_runtime_unavailable',
        'Remote runtime browser host lease is unavailable.'
      )
    }
    const response = await sender.sendPageMetadataRequest(
      params,
      BROWSER_CLIENT_PAGE_METADATA_REQUEST_TIMEOUT_MS
    )
    if (!response.ok) {
      throw new RemoteRuntimeClientError(response.error.code, response.error.message)
    }
    const ack = BrowserClientPageMetadataAck.safeParse(response.result)
    if (!ack.success) {
      throw new Error('browser_client_page_metadata_ack_invalid')
    }
    return ack.data
  }
}

// Each environment must publish through its own lease.
const transportsByEnvironmentId = new Map<string, BrowserClientPageMetadataTransport>()

export function registerBrowserClientPageMetadataTransport(
  environmentId: string,
  transport: BrowserClientPageMetadataTransport
): () => void {
  transportsByEnvironmentId.set(environmentId, transport)
  return () => {
    if (transportsByEnvironmentId.get(environmentId) === transport) {
      transportsByEnvironmentId.delete(environmentId)
    }
  }
}

export function resetBrowserClientPageMetadataTransports(): void {
  transportsByEnvironmentId.clear()
}

export function publishBrowserClientPageMetadata(
  environmentId: string,
  params: unknown
): Promise<{ accepted: boolean }> {
  const transport = transportsByEnvironmentId.get(environmentId)
  if (!transport) {
    return Promise.reject(
      new RemoteRuntimeClientError(
        'remote_runtime_unavailable',
        `No browser client host is hosting pages for ${environmentId}.`
      )
    )
  }
  return transport.publish(params)
}
