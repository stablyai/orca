import type { BrowserClientHostLeaseAuthority } from '../../shared/browser-client-host-protocol'

export type PairedRuntimeBrowserClientHostStart = {
  environmentId: string
  pairingRevision: number
  authorityRuntimeId: string
}

type RegisteredBrowserClientHost = {
  start(): Promise<BrowserClientHostLeaseAuthority>
  retirePage(browserPageId: string, pageHostGeneration: number): Promise<boolean>
  close(error?: Error): Promise<boolean>
  whenClosed(): Promise<void>
}

type PairedRuntimeBrowserClientHostRegistryOptions<
  Start extends PairedRuntimeBrowserClientHostStart
> = {
  createComposition(input: Start): RegisteredBrowserClientHost
}

type EnvironmentHostRecord = {
  pairingRevision: number
  authorityRuntimeId: string
  composition: RegisteredBrowserClientHost
  authority: Promise<BrowserClientHostLeaseAuthority>
  cleanupPending: boolean
}

export class PairedRuntimeBrowserClientHostRegistry<
  Start extends PairedRuntimeBrowserClientHostStart = PairedRuntimeBrowserClientHostStart
> {
  private readonly hosts = new Map<string, EnvironmentHostRecord>()
  private readonly operations = new Map<string, Promise<void>>()
  private closePromise: Promise<void> | null = null
  private closed = false

  constructor(private readonly options: PairedRuntimeBrowserClientHostRegistryOptions<Start>) {}

  start(input: Start): Promise<BrowserClientHostLeaseAuthority> {
    if (this.closed) {
      return Promise.reject(new Error('paired_runtime_browser_client_host_registry_closed'))
    }
    return this.enqueue(input.environmentId, async () => {
      if (this.closed) {
        throw new Error('paired_runtime_browser_client_host_registry_closed')
      }
      const existing = this.hosts.get(input.environmentId)
      if (existing?.cleanupPending) {
        throw new Error('paired_runtime_browser_client_host_cleanup_pending')
      }
      if (
        existing?.pairingRevision === input.pairingRevision &&
        existing.authorityRuntimeId === input.authorityRuntimeId
      ) {
        return existing.authority
      }
      if (existing) {
        let settled = false
        try {
          settled = await existing.composition.close(
            new Error('Browser client host environment authority was replaced')
          )
        } catch (error) {
          this.retainCleanupTombstone(input.environmentId, existing)
          throw error
        }
        if (!settled) {
          this.retainCleanupTombstone(input.environmentId, existing)
          throw new Error('paired_runtime_browser_client_host_cleanup_pending')
        }
        this.hosts.delete(input.environmentId)
      }
      const composition = this.options.createComposition(input)
      const authority = composition.start()
      const record = {
        pairingRevision: input.pairingRevision,
        authorityRuntimeId: input.authorityRuntimeId,
        composition,
        authority,
        cleanupPending: false
      }
      this.hosts.set(input.environmentId, record)
      try {
        return await authority
      } catch (error) {
        const cleanupSettled = await composition.close(asError(error)).catch(() => false)
        if (cleanupSettled && this.hosts.get(input.environmentId) === record) {
          this.hosts.delete(input.environmentId)
        } else {
          this.retainCleanupTombstone(input.environmentId, record)
        }
        throw error
      }
    })
  }

  retirePage(
    environmentId: string,
    browserPageId: string,
    pageHostGeneration: number
  ): Promise<boolean> {
    return this.enqueue(environmentId, async () => {
      const record = this.hosts.get(environmentId)
      if (!record) {
        return false
      }
      await record.authority
      return record.composition.retirePage(browserPageId, pageHostGeneration)
    })
  }

  closeEnvironment(environmentId: string, error?: Error): Promise<boolean> {
    return this.enqueue(environmentId, async () => {
      const record = this.hosts.get(environmentId)
      if (!record) {
        return false
      }
      let settled = false
      try {
        settled = await record.composition.close(error)
      } catch (closeError) {
        this.retainCleanupTombstone(environmentId, record)
        throw closeError
      }
      if (settled && this.hosts.get(environmentId) === record) {
        this.hosts.delete(environmentId)
      } else if (!settled) {
        this.retainCleanupTombstone(environmentId, record)
      }
      return settled
    })
  }

  close(): Promise<void> {
    this.closed = true
    this.closePromise ??= this.closeAllEnvironments()
    return this.closePromise
  }

  private enqueue<T>(environmentId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.operations.get(environmentId) ?? Promise.resolve()
    const result = previous.then(operation, operation)
    const tracked = result.then(
      () => undefined,
      () => undefined
    )
    this.operations.set(environmentId, tracked)
    void tracked.finally(() => {
      if (this.operations.get(environmentId) === tracked) {
        this.operations.delete(environmentId)
      }
    })
    return result
  }

  private async closeAllEnvironments(): Promise<void> {
    const environmentIds = new Set([...this.hosts.keys(), ...this.operations.keys()])
    const results = await Promise.allSettled(
      [...environmentIds].map((environmentId) =>
        this.closeEnvironment(environmentId, new Error('Browser client host registry is closed'))
      )
    )
    const failures = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : []
    )
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Browser client host registry cleanup failed')
    }
  }

  private retainCleanupTombstone(environmentId: string, record: EnvironmentHostRecord): void {
    if (record.cleanupPending) {
      return
    }
    record.cleanupPending = true
    void record.composition
      .whenClosed()
      .then(() =>
        this.enqueue(environmentId, async () => {
          if (this.hosts.get(environmentId) === record) {
            this.hosts.delete(environmentId)
          }
        })
      )
      .catch(() => undefined)
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
