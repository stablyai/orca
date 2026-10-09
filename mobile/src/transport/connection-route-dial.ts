import {
  ConnectionRouteError,
  assertConnectionRouteActive,
  type ConnectionRouteLease,
  type ConnectionRouteProvider
} from './connection-route'

/** One route lease per WebSocket generation; stale asynchronous opens never publish. */
export class ConnectionRouteDial {
  private pending: AbortController | null = null
  private lease: ConnectionRouteLease | null = null

  constructor(private readonly provider: ConnectionRouteProvider) {}

  open(
    endpoint: string,
    ready: (lease: ConnectionRouteLease) => void,
    failed: (error: unknown) => void
  ): void {
    this.close()
    const controller = new AbortController()
    this.pending = controller
    const timeout = setTimeout(() => {
      if (this.pending !== controller) {
        return
      }
      this.close()
      failed(new ConnectionRouteError('Connection tunnel timed out.', true))
    }, 20_000)
    void Promise.resolve()
      .then(() => {
        assertConnectionRouteActive(controller.signal)
        return this.provider.open(endpoint, controller.signal)
      })
      .then(
        (lease) => {
          clearTimeout(timeout)
          if (this.pending !== controller) {
            lease.close()
            return
          }
          this.lease = lease
          try {
            ready(lease)
          } catch (error) {
            this.close()
            failed(error)
          }
        },
        (error: unknown) => {
          clearTimeout(timeout)
          if (this.pending !== controller) {
            return
          }
          this.close()
          failed(error)
        }
      )
    controller.signal.addEventListener('abort', () => clearTimeout(timeout), { once: true })
  }

  close(): void {
    const pending = this.pending
    this.pending = null
    pending?.abort()
    const lease = this.lease
    this.lease = null
    lease?.close()
  }
}
