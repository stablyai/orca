import {
  BrowserClientHostEvent,
  type BrowserHostLeaseAuthority
} from '../../shared/browser-client-host-protocol'
import type { PairingOffer } from '../../shared/pairing'
import { BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY } from '../../shared/protocol-version'
import {
  subscribeRemoteRuntimeRequest,
  type RemoteRuntimeSubscription,
  type RemoteRuntimeSubscriptionOptions
} from '../../shared/remote-runtime-client'
import { RemoteRuntimeClientError } from '../../shared/remote-runtime-client-error'

type PairedRuntimeBrowserHostLeaseOptions = {
  pairing: PairingOffer
  authorityRuntimeId: string
  browserHostClientId: string
  hostCapabilities: readonly string[]
  timeoutMs?: number
  subscription?: RemoteRuntimeSubscriptionOptions
  onError?: (error: Error) => void
}

export class PairedRuntimeBrowserHostLease {
  private subscription: RemoteRuntimeSubscription | null = null
  private startPromise: Promise<BrowserHostLeaseAuthority> | null = null
  private closePromise: Promise<void> | null = null
  private rejectReady: ((error: Error) => void) | null = null
  private authority: BrowserHostLeaseAuthority | null = null
  private closed = false

  constructor(private readonly options: PairedRuntimeBrowserHostLeaseOptions) {}

  start(): Promise<BrowserHostLeaseAuthority> {
    if (this.closed) {
      return Promise.reject(new Error('Browser host lease is closed'))
    }
    this.startPromise ??= this.startLease()
    return this.startPromise
  }

  async close(error = new Error('Browser host lease is closed')): Promise<void> {
    if (this.closePromise) {
      return this.closePromise
    }
    this.closed = true
    this.rejectReady?.(error)
    this.closePromise = this.closeLease()
    return this.closePromise
  }

  private async startLease(): Promise<BrowserHostLeaseAuthority> {
    const timeoutMs = this.options.timeoutMs ?? 15_000
    let resolveReady = (_authority: BrowserHostLeaseAuthority): void => {}
    let rejectReady = (_error: Error): void => {}
    const ready = new Promise<BrowserHostLeaseAuthority>((resolve, reject) => {
      resolveReady = resolve
      rejectReady = reject
    })
    void ready.catch(() => undefined)
    let readyTimeout: ReturnType<typeof setTimeout> | null = null
    try {
      const subscription = await subscribeRemoteRuntimeRequest(
        this.options.pairing,
        'browser.clientHost.attach',
        {
          authorityRuntimeId: this.options.authorityRuntimeId,
          browserHostClientId: this.options.browserHostClientId,
          hostCapabilities: [...this.options.hostCapabilities]
        },
        timeoutMs,
        {
          onResponse: (response) => {
            if (!response.ok) {
              this.fail(
                new RemoteRuntimeClientError(response.error.code, response.error.message),
                rejectReady
              )
              return
            }
            const parsed = BrowserClientHostEvent.safeParse(response.result)
            if (!parsed.success || response._meta.runtimeId !== this.options.authorityRuntimeId) {
              this.fail(new Error('Invalid browser host lease response'), rejectReady)
              return
            }
            if (parsed.data.type === 'revoked') {
              if (
                !this.authority ||
                this.authority.authorityEpoch !== parsed.data.authorityEpoch ||
                this.authority.browserHostGeneration !== parsed.data.browserHostGeneration
              ) {
                this.fail(new Error('Invalid browser host lease revocation'), rejectReady)
                return
              }
              this.fail(new Error(`Browser host lease revoked: ${parsed.data.reason}`), rejectReady)
              return
            }
            const authority = {
              authorityRuntimeId: this.options.authorityRuntimeId,
              authorityEpoch: parsed.data.authorityEpoch,
              browserHostClientId: this.options.browserHostClientId,
              browserHostGeneration: parsed.data.browserHostGeneration
            }
            if (this.authority) {
              if (!sameAuthority(this.authority, authority)) {
                this.fail(new Error('Browser host lease authority changed in place'), rejectReady)
              }
              return
            }
            this.authority = authority
            resolveReady(authority)
          },
          onError: (leaseError) => this.fail(leaseError, rejectReady),
          onClose: () => this.fail(new Error('Browser host lease transport closed'), rejectReady)
        },
        {
          ...this.options.subscription,
          clientCapabilities: [
            ...(this.options.subscription?.clientCapabilities ?? []),
            BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY
          ]
        }
      )
      if (this.closed) {
        subscription.close()
        throw new Error('Browser host lease closed during startup')
      }
      this.subscription = subscription
      this.rejectReady = rejectReady
      readyTimeout = setTimeout(
        () =>
          rejectReady(
            new RemoteRuntimeClientError('runtime_timeout', 'Browser host lease attach timed out.')
          ),
        timeoutMs
      )
      return await ready
    } catch (error) {
      const leaseError = error instanceof Error ? error : new Error(String(error))
      await this.close(leaseError)
      throw leaseError
    } finally {
      if (readyTimeout) {
        clearTimeout(readyTimeout)
      }
      this.rejectReady = null
    }
  }

  private fail(error: Error, rejectReady: (error: Error) => void): void {
    if (this.closed) {
      return
    }
    if (!this.authority) {
      rejectReady(error)
    }
    const closing = this.close(error)
    this.reportError(error)
    void closing.catch((closeError) =>
      this.reportError(closeError instanceof Error ? closeError : new Error(String(closeError)))
    )
  }

  private async closeLease(): Promise<void> {
    this.subscription?.close()
    this.subscription = null
  }

  private reportError(error: Error): void {
    try {
      this.options.onError?.(error)
    } catch {
      // A reporting callback cannot prevent lease cleanup.
    }
  }
}

function sameAuthority(left: BrowserHostLeaseAuthority, right: BrowserHostLeaseAuthority): boolean {
  return (
    left.authorityRuntimeId === right.authorityRuntimeId &&
    left.authorityEpoch === right.authorityEpoch &&
    left.browserHostClientId === right.browserHostClientId &&
    left.browserHostGeneration === right.browserHostGeneration
  )
}
