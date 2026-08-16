import {
  BrowserClientHostEvent,
  BrowserClientHostCommandResult,
  BrowserClientHostCommandResultAck,
  type BrowserClientHostCommandEvent,
  type BrowserClientHostCommandResult as BrowserClientHostCommandResultType,
  type BrowserClientHostLeaseAuthority
} from '../../shared/browser-client-host-protocol'
import { BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY } from '../../shared/protocol-version'
import {
  subscribeRemoteRuntimeRequest,
  type RemoteRuntimeSubscription
} from '../../shared/remote-runtime-client'
import { RemoteRuntimeClientError } from '../../shared/remote-runtime-client-error'
import { sameBrowserClientHostLeaseAuthority } from './browser-client-host-command-authority'
import {
  BrowserHostCommandResultSettler,
  type BrowserHostCommandResultAdmission
} from './browser-host-command-result-settler'
import type { PairedRuntimeBrowserHostLeaseOptions } from './paired-runtime-browser-host-lease-options'

export class PairedRuntimeBrowserHostLease {
  private subscription: RemoteRuntimeSubscription | null = null
  private startPromise: Promise<BrowserClientHostLeaseAuthority> | null = null
  private closePromise: Promise<void> | null = null
  private rejectReady: ((error: Error) => void) | null = null
  private authority: BrowserClientHostLeaseAuthority | null = null
  private readonly commandResultSettler: BrowserHostCommandResultSettler
  private closed = false

  constructor(private readonly options: PairedRuntimeBrowserHostLeaseOptions) {
    this.commandResultSettler = new BrowserHostCommandResultSettler({
      maxConcurrent: options.maxConcurrentCommandResults,
      maxUnsettled: options.maxUnsettledCommandResults,
      submit: (command, result) => this.submitPageCommandResult(command, result),
      onError: (error, rejectReady) => this.fail(error, rejectReady)
    })
  }

  start(): Promise<BrowserClientHostLeaseAuthority> {
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

  private async startLease(): Promise<BrowserClientHostLeaseAuthority> {
    const timeoutMs = this.options.timeoutMs ?? 15_000
    let resolveReady = (_authority: BrowserClientHostLeaseAuthority): void => {}
    let rejectReady = (_error: Error): void => {}
    const ready = new Promise<BrowserClientHostLeaseAuthority>((resolve, reject) => {
      resolveReady = resolve
      rejectReady = reject
    })
    void ready.catch(() => undefined)
    let readyTimeout: ReturnType<typeof setTimeout> | null = null
    try {
      const pageCommandProtocolVersion = this.requestedPageCommandProtocolVersion()
      const subscription = await subscribeRemoteRuntimeRequest(
        this.options.pairing,
        'browser.clientHost.attach',
        {
          authorityRuntimeId: this.options.authorityRuntimeId,
          browserHostClientId: this.options.browserHostClientId,
          hostCapabilities: [...this.options.hostCapabilities],
          ...(pageCommandProtocolVersion ? { pageCommandProtocolVersion } : {})
        },
        timeoutMs,
        {
          onResponse: (response) => {
            if (this.closed) {
              return
            }
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
            if (parsed.data.type === 'command') {
              this.handlePageCommand(parsed.data, rejectReady)
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
            if (
              parsed.data.pageCommandProtocolVersion !== undefined &&
              parsed.data.pageCommandProtocolVersion !== pageCommandProtocolVersion
            ) {
              this.fail(new Error('Invalid browser host lease response'), rejectReady)
              return
            }
            if (parsed.data.pageCommandProtocolVersion && !this.subscription?.sendRequest) {
              this.fail(new Error('Browser host command result transport unavailable'), rejectReady)
              return
            }
            const authority = Object.freeze({
              authorityRuntimeId: this.options.authorityRuntimeId,
              authorityEpoch: parsed.data.authorityEpoch,
              browserHostClientId: this.options.browserHostClientId,
              browserHostGeneration: parsed.data.browserHostGeneration,
              ...(parsed.data.pageCommandProtocolVersion
                ? { pageCommandProtocolVersion: parsed.data.pageCommandProtocolVersion }
                : {})
            })
            if (this.authority) {
              if (!sameBrowserClientHostLeaseAuthority(this.authority, authority)) {
                this.fail(new Error('Browser host lease authority changed in place'), rejectReady)
              }
              return
            }
            try {
              this.options.onAuthority?.(authority)
            } catch (error) {
              this.fail(error instanceof Error ? error : new Error(String(error)), rejectReady)
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

  private requestedPageCommandProtocolVersion(): 1 | undefined {
    return this.options.onPageCommand ? this.options.pageCommandProtocolVersion : undefined
  }

  private handlePageCommand(
    command: BrowserClientHostCommandEvent,
    rejectReady: (error: Error) => void
  ): void {
    const authority = this.authority
    if (
      !authority?.pageCommandProtocolVersion ||
      !this.options.onPageCommand ||
      command.pageCommandProtocolVersion !== authority.pageCommandProtocolVersion
    ) {
      this.fail(new Error('Unnegotiated browser host page command'), rejectReady)
      return
    }
    if (
      command.authorityRuntimeId !== authority.authorityRuntimeId ||
      command.authorityEpoch !== authority.authorityEpoch ||
      command.browserHostClientId !== authority.browserHostClientId ||
      command.browserHostGeneration !== authority.browserHostGeneration
    ) {
      this.fail(new Error('Stale browser host page command'), rejectReady)
      return
    }
    const admission = this.commandResultSettler.admit()
    if (!admission) {
      this.fail(new Error('Browser host command result capacity reached'), rejectReady)
      return
    }
    try {
      void Promise.resolve(this.options.onPageCommand(command))
        .then((result) => this.enqueuePageCommandResult(admission, command, result, rejectReady))
        .catch((error) => {
          this.commandResultSettler.release(admission)
          this.fail(error instanceof Error ? error : new Error(String(error)), rejectReady)
        })
    } catch (error) {
      this.commandResultSettler.release(admission)
      this.fail(error instanceof Error ? error : new Error(String(error)), rejectReady)
    }
  }

  private enqueuePageCommandResult(
    admission: BrowserHostCommandResultAdmission,
    command: BrowserClientHostCommandEvent,
    candidate: BrowserClientHostCommandResultType,
    rejectReady: (error: Error) => void
  ): void {
    const result = BrowserClientHostCommandResult.parse(candidate)
    this.commandResultSettler.enqueue(admission, command, result, rejectReady)
  }

  private async submitPageCommandResult(
    command: BrowserClientHostCommandEvent,
    candidate: BrowserClientHostCommandResultType
  ): Promise<void> {
    if (this.closed) {
      return
    }
    const result = BrowserClientHostCommandResult.parse(candidate)
    const sendRequest = this.subscription?.sendRequest
    if (!sendRequest) {
      throw new Error('Browser host command result transport unavailable')
    }
    const response = await sendRequest(
      'browser.clientHost.commandResult',
      {
        pageCommandProtocolVersion: command.pageCommandProtocolVersion,
        authorityRuntimeId: command.authorityRuntimeId,
        authorityEpoch: command.authorityEpoch,
        browserHostClientId: command.browserHostClientId,
        browserHostGeneration: command.browserHostGeneration,
        browserPageId: command.browserPageId,
        pageHostGeneration: command.pageHostGeneration,
        commandSequence: command.commandSequence,
        commandId: command.commandId,
        result
      },
      this.options.timeoutMs ?? 15_000
    )
    if (!response.ok) {
      throw new RemoteRuntimeClientError(response.error.code, response.error.message)
    }
    if (
      response._meta.runtimeId !== command.authorityRuntimeId ||
      !BrowserClientHostCommandResultAck.safeParse(response.result).success
    ) {
      throw new Error('Invalid browser host command result acknowledgement')
    }
  }

  private async closeLease(): Promise<void> {
    this.commandResultSettler.close()
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
