import { BrowserClientPageMetadataAck } from '../../shared/browser-client-page-metadata-protocol'
import { RemoteRuntimeClientError } from '../../shared/remote-runtime-client-error'
import type { RuntimeRpcResponse } from '../../shared/runtime-rpc-envelope'

export type BrowserClientPageMetadataSender = {
  sendPageMetadataRequest(params: unknown, timeoutMs: number): Promise<RuntimeRpcResponse<unknown>>
}

/**
 * Not a latency budget — a liveness one. A request that times out on the lease's subscription tears
 * the whole subscription down, fencing every page the host is running. Metadata is the most
 * frequent traffic on that socket and the least important, so it must never be the message that
 * declares a working lease dead: it waits at least as long as anything else sharing the connection.
 */
export const BROWSER_CLIENT_PAGE_METADATA_REQUEST_TIMEOUT_MS = 30_000

/**
 * Carries a page's url/title back to the runtime over the browser-host lease.
 *
 * Why the lease and not an ordinary runtime call: the runtime only accepts page traffic on the
 * connection the lease attached on (`browser-host-client-page-connection.ts`), and every other
 * transport — shared control, one-shot sockets — has a different connection id. A publish sent any
 * other way is rejected as a stale lease, every time, which leaves the runtime's copy of the page
 * frozen at the URL it was created with. The file channel rides this same seam for the same reason.
 */
export class BrowserClientPageMetadataTransport {
  private sender: BrowserClientPageMetadataSender | null = null

  /**
   * Why the transport and not the navigate command: a guest the user drives -- a link, a form, a
   * redirect -- never issues one, so the page inventory would keep naming the URL the page was
   * created at. This is the only seam that sees every navigation.
   */
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

/**
 * One transport per client-host composition, keyed by environment: a page belongs to the lease of
 * the environment that owns it, and publishing through whichever composition composed last would
 * address another runtime's lease.
 */
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
