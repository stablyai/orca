import type { PtyOwnershipTransferIdentity } from '../../shared/pty-ownership-transfer-journal'
import { samePtyOwnershipTransferIdentity } from '../../shared/pty-ownership-transfer-identity'
import { connectOrcadDelegatedTransfer } from './orcad-delegated-connection'
import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'

type Connection = Awaited<ReturnType<typeof connectOrcadDelegatedTransfer>>
type Destination = Omit<Parameters<typeof connectOrcadDelegatedTransfer>[0], 'signal' | 'onError'>
type Entry = {
  destination: Destination
  controller: AbortController
  connection?: Connection
  pending?: Promise<void>
  quiescing?: Promise<void>
  timer?: ReturnType<typeof setTimeout>
  removeDispose?: () => void
  removeBinding?: () => void
  attempts: number
  connectionError?: unknown
  retirement?: Promise<void>
}

const RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000] as const

/** One instance per locked host runtime; shutdown must settle before releasing its instance lock. */
export class OrcadDelegatedConnectionSupervisor {
  private readonly entries = new Map<string, Entry>()
  private stopped = false
  private stopping?: Promise<void>
  private readonly stopController = new AbortController()

  get signal(): AbortSignal {
    return this.stopController.signal
  }

  constructor(
    private readonly options: {
      signal: AbortSignal
      onError: (identity: PtyOwnershipTransferIdentity, error: unknown) => void
      retryAfterBudget?: (error: unknown) => boolean
      recoverRetirement?: (destination: Destination) => boolean
      /** Bind atomically; a throwing installer must undo its own partial registration. */
      bindConnection?: (
        identity: PtyOwnershipTransferIdentity,
        connection: Connection
      ) => () => void
    }
  ) {
    options.signal.addEventListener('abort', this.onAbort, { once: true })
    if (options.signal.aborted) {
      void this.stop()
    }
  }

  track(destination: Destination): void {
    if (this.stopped) {
      throw new Error('orcad_delegated_supervisor_stopped')
    }
    const existing = this.entries.get(destination.identity.bridgeId)
    if (existing) {
      if (
        !samePtyOwnershipTransferIdentity(existing.destination.identity, destination.identity) ||
        existing.destination.adapter !== destination.adapter ||
        existing.destination.store !== destination.store ||
        existing.destination.outbox !== destination.outbox ||
        existing.destination.prepareModelFrame !== destination.prepareModelFrame ||
        existing.destination.onExit !== destination.onExit ||
        existing.destination.onExecutionState !== destination.onExecutionState ||
        existing.destination.initializeModel !== destination.initializeModel ||
        existing.destination.providerModel !== destination.providerModel
      ) {
        throw new Error('orcad_delegated_supervisor_destination_conflict')
      }
      if (existing.retirement) {
        throw new Error('orcad_delegated_supervisor_destination_retired')
      }
      return
    }
    const entry: Entry = {
      destination: { ...destination, identity: Object.freeze({ ...destination.identity }) },
      controller: new AbortController(),
      attempts: 0
    }
    this.entries.set(destination.identity.bridgeId, entry)
    this.connect(entry)
  }

  getConnection(identity: PtyOwnershipTransferIdentity): Connection | null {
    const entry = this.requireEntry(identity)
    return !this.stopped && !entry.retirement && entry.connection?.isActive()
      ? entry.connection
      : null
  }

  /** Settle the current attempts, not future retries; settlement alone does not prove liveness. */
  async settlePendingConnections(): Promise<void> {
    await Promise.all([...this.entries.values()].map((entry) => entry.pending))
  }

  async settlePendingConnection(
    identity: PtyOwnershipTransferIdentity,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    await waitForPromiseWithSignal(this.requireEntry(identity).pending ?? Promise.resolve(), signal)
    signal.throwIfAborted()
  }

  getConnectionError(identity: PtyOwnershipTransferIdentity): unknown {
    return this.requireEntry(identity).connectionError
  }

  /** Explicit retry reopens the bounded attempt budget, never an uncertain source journal. */
  retry(identity: PtyOwnershipTransferIdentity): void {
    if (this.stopped) {
      throw new Error('orcad_delegated_supervisor_stopped')
    }
    const entry = this.requireEntry(identity)
    if (entry.retirement) {
      throw new Error('orcad_delegated_supervisor_destination_retired')
    }
    if (entry.pending || entry.connection?.isActive()) {
      return
    }
    if (entry.timer) {
      clearTimeout(entry.timer)
    }
    entry.timer = undefined
    entry.attempts = 0
    this.connect(entry)
  }

  /** Requires accepted durable retirement; defer disposal until synchronous exit observers finish. */
  retire(identity: PtyOwnershipTransferIdentity): Promise<void> {
    const entry = this.requireEntry(identity)
    if (entry.retirement) {
      return entry.retirement
    }
    if (entry.timer) {
      clearTimeout(entry.timer)
    }
    entry.timer = undefined
    entry.retirement = Promise.resolve().then(async () => {
      this.disconnect(entry)
      await entry.pending
      await entry.quiescing
    })
    return entry.retirement
  }

  stop(): Promise<void> {
    if (this.stopping) {
      return this.stopping
    }
    this.stopped = true
    this.stopController.abort(new Error('orcad_delegated_supervisor_stopped'))
    this.options.signal.removeEventListener('abort', this.onAbort)
    for (const entry of this.entries.values()) {
      if (entry.timer) {
        clearTimeout(entry.timer)
      }
      entry.timer = undefined
      this.disconnect(entry)
    }
    this.stopping = Promise.all(
      [...this.entries.values()].flatMap((entry) => [
        entry.pending,
        entry.quiescing,
        entry.retirement
      ])
    ).then(() => {
      this.entries.clear()
    })
    return this.stopping
  }

  private readonly onAbort = () => {
    void this.stop()
  }

  private requireEntry(identity: PtyOwnershipTransferIdentity): Entry {
    const entry = this.entries.get(identity.bridgeId)
    if (!entry || !samePtyOwnershipTransferIdentity(entry.destination.identity, identity)) {
      throw new Error('orcad_delegated_supervisor_destination_unavailable')
    }
    return entry
  }

  private report(entry: Entry, error: unknown): void {
    try {
      this.options.onError(entry.destination.identity, error)
    } catch {
      // A diagnostic callback must not bypass connection fencing or shutdown.
    }
  }

  private disconnect(entry: Entry): void {
    entry.removeDispose?.()
    entry.removeDispose = undefined
    const connection = entry.connection
    entry.connection = undefined
    const removeBinding = entry.removeBinding
    entry.removeBinding = undefined
    if (removeBinding) {
      this.removeBinding(entry, removeBinding)
    }
    entry.controller.abort()
    if (connection) {
      const prior = entry.quiescing
      const disposed = connection.dispose()
      entry.quiescing = Promise.all([prior, disposed]).then(() => undefined)
    }
  }

  private removeBinding(entry: Entry, remove: () => void): void {
    try {
      remove()
    } catch (error) {
      this.report(entry, error)
    }
  }

  private connect(entry: Entry): void {
    if (this.stopped || entry.retirement || entry.pending || entry.connection?.isActive()) {
      return
    }
    this.disconnect(entry)
    entry.controller = new AbortController()
    entry.attempts += 1
    entry.connectionError = undefined
    entry.pending = Promise.resolve()
      .then(async () => {
        if (entry.quiescing) {
          await entry.quiescing
        }
        if (this.stopped || entry.retirement) {
          return
        }
        if (this.options.recoverRetirement?.(entry.destination)) {
          void this.retire(entry.destination.identity).catch((error) => this.report(entry, error))
          return
        }
        const connection = await connectOrcadDelegatedTransfer({
          ...entry.destination,
          signal: entry.controller.signal,
          onError: (error) => this.report(entry, error)
        })
        if (this.stopped || entry.retirement || !connection.isActive()) {
          await connection.dispose()
          return
        }
        entry.connection = connection
        entry.removeDispose = connection.multiplexer.onDispose(() => {
          this.disconnect(entry)
          this.schedule(entry)
        })
        if (!connection.isActive()) {
          this.disconnect(entry)
          return
        }
        const removeBinding = this.options.bindConnection?.(entry.destination.identity, connection)
        if (removeBinding) {
          if (
            this.stopped ||
            entry.retirement ||
            entry.connection !== connection ||
            !connection.isActive()
          ) {
            this.removeBinding(entry, removeBinding)
          } else {
            entry.removeBinding = removeBinding
          }
        }
      })
      .catch((error) => {
        entry.connectionError = error
        this.disconnect(entry)
        if (!this.stopped && !entry.retirement) {
          this.report(entry, error)
        }
      })
      .finally(() => {
        entry.pending = undefined
        if (!entry.connection?.isActive()) {
          this.schedule(entry)
        }
      })
  }

  private schedule(entry: Entry): void {
    if (
      this.stopped ||
      entry.retirement ||
      entry.pending ||
      entry.timer ||
      entry.connection?.isActive()
    ) {
      return
    }
    const delay =
      RETRY_DELAYS_MS[entry.attempts - 1] ??
      (this.options.retryAfterBudget?.(entry.connectionError) ? 30_000 : undefined)
    if (delay === undefined) {
      return
    }
    entry.timer = setTimeout(() => {
      entry.timer = undefined
      this.connect(entry)
    }, delay)
    entry.timer.unref?.()
  }
}
