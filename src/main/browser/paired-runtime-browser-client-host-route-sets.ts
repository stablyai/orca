import type { BrowserClientHostLeaseAuthority } from '../../shared/browser-client-host-protocol'
import type { BrowserClientPageNetworkRoute } from './browser-client-page-cleanup'
import { sameBrowserClientHostLeaseAuthority } from './browser-client-host-command-authority'

export type ComposedBrowserClientNetworkRoutes = {
  retain(key: string, signal: AbortSignal): Promise<BrowserClientPageNetworkRoute>
  suspend(error?: Error): void
  reconnect(): Promise<void>
  retire(error?: Error): Promise<void>
  close(error?: Error): Promise<void>
}

type RouteSetOptions<Start> = {
  createRoutes(
    input: Start,
    authority: BrowserClientHostLeaseAuthority
  ): ComposedBrowserClientNetworkRoutes
  onRecoveryError(error: Error): void
  onCleanupError(error: Error): void
}

export class PairedRuntimeBrowserClientHostRouteSets<Start> {
  private current: {
    authority: BrowserClientHostLeaseAuthority
    routes: ComposedBrowserClientNetworkRoutes
  } | null = null
  private readonly retired = new Set<ComposedBrowserClientNetworkRoutes>()
  private recovery: ReturnType<typeof createRouteRecoveryGate> | null = null
  private recoveryGeneration = 0
  private closed = false

  constructor(private readonly options: RouteSetOptions<Start>) {}

  retain(key: string, signal: AbortSignal): Promise<BrowserClientPageNetworkRoute> {
    return this.requireCurrent().routes.retain(key, signal)
  }

  activate(input: Start, authority: BrowserClientHostLeaseAuthority): void {
    if (this.closed || this.current) {
      throw new Error('browser_client_network_route_authority_unavailable')
    }
    this.current = { authority, routes: this.options.createRoutes(input, authority) }
  }

  suspend(error: Error): void {
    if (this.closed) {
      return
    }
    if (!this.recovery) {
      this.recovery = createRouteRecoveryGate()
      void this.recovery.promise.catch(() => undefined)
    }
    this.recoveryGeneration += 1
    this.requireCurrent().routes.suspend(error)
  }

  reconnect(authority: BrowserClientHostLeaseAuthority): void {
    const current = this.current
    if (
      this.closed ||
      !current ||
      !sameBrowserClientHostLeaseAuthority(current.authority, authority)
    ) {
      throw new Error('browser_client_network_route_authority_changed')
    }
    const recovery = this.recovery
    if (!recovery) {
      throw new Error('browser_client_network_route_recovery_unexpected')
    }
    const generation = this.recoveryGeneration
    void current.routes
      .reconnect()
      .then(() => {
        if (this.recovery === recovery && this.recoveryGeneration === generation) {
          this.recovery = null
          recovery.resolve()
        }
      })
      .catch((error) => this.failRecovery(recovery, generation, asError(error)))
  }

  waitForRecovery(signal: AbortSignal): Promise<void> {
    return this.recovery ? waitForRouteRecovery(this.recovery.promise, signal) : Promise.resolve()
  }

  retireCurrent(error: Error): void {
    this.rejectRecovery(error)
    const current = this.current
    if (!current) {
      return
    }
    this.current = null
    this.retired.add(current.routes)
    const retiring = current.routes.retire(error)
    void retiring.then(
      () => this.retired.delete(current.routes),
      (retirementError) => this.options.onCleanupError(asError(retirementError))
    )
  }

  fence(error: Error): void {
    try {
      this.current?.routes.suspend(error)
    } catch (routeError) {
      this.options.onCleanupError(asError(routeError))
    }
  }

  async close(error: Error): Promise<void> {
    this.closed = true
    this.rejectRecovery(error)
    const routes = new Set(this.retired)
    if (this.current) {
      routes.add(this.current.routes)
    }
    this.current = null
    const results = await Promise.allSettled([...routes].map((entry) => entry.close(error)))
    const failures = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : []
    )
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Browser client host route cleanup failed')
    }
  }

  private requireCurrent(): NonNullable<PairedRuntimeBrowserClientHostRouteSets<Start>['current']> {
    if (!this.current || this.closed) {
      throw new Error('browser_client_network_route_authority_unavailable')
    }
    return this.current
  }

  private failRecovery(
    recovery: ReturnType<typeof createRouteRecoveryGate>,
    generation: number,
    error: Error
  ): void {
    if (this.recovery !== recovery || this.recoveryGeneration !== generation) {
      return
    }
    this.recovery = null
    recovery.reject(error)
    this.options.onRecoveryError(error)
  }

  private rejectRecovery(error: Error): void {
    const recovery = this.recovery
    if (!recovery) {
      return
    }
    this.recovery = null
    recovery.reject(error)
  }
}

function createRouteRecoveryGate(): {
  promise: Promise<void>
  resolve: () => void
  reject: (error: Error) => void
} {
  let resolve = (): void => {}
  let reject = (_error: Error): void => {}
  const promise = new Promise<void>((innerResolve, innerReject) => {
    resolve = innerResolve
    reject = innerReject
  })
  return { promise, resolve, reject }
}

function waitForRouteRecovery(recovery: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(new Error('browser_client_host_command_aborted'))
  }
  return new Promise((resolve, reject) => {
    const abort = (): void => reject(new Error('browser_client_host_command_aborted'))
    signal.addEventListener('abort', abort, { once: true })
    void recovery.then(
      () => {
        signal.removeEventListener('abort', abort)
        resolve()
      },
      (error) => {
        signal.removeEventListener('abort', abort)
        reject(error)
      }
    )
  })
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
