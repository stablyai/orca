import type { SshConnection } from './ssh-connection'
import { Ssh2PortForwardProvider } from './ssh2-port-forward-provider'
import { SystemSshPortForwardProvider } from './system-ssh-port-forward-provider'
import type { PortForwardEntry } from '../../shared/ssh-types'
import type {
  PortForwardCloseReason,
  SshPortForwardProvider,
  StartedPortForward
} from './ssh-port-forward-provider'

export type { PortForwardEntry }
export type { PortForwardCloseReason }

type SshPortForwardManagerCallbacks = {
  onForwardClosed?: (entry: PortForwardEntry, reason: PortForwardCloseReason) => void
}

type PortForwardOperation = {
  id: string
  connectionId: string
  cancelled: boolean
  completion: Promise<void>
  cleanupFailure?: { error: unknown }
}

export class SshPortForwardManager {
  private forwards = new Map<string, StartedPortForward>()
  private operations = new Set<PortForwardOperation>()
  private nextId = 1
  private providers: SshPortForwardProvider[]
  private callbacks: SshPortForwardManagerCallbacks

  constructor(
    callbacks: SshPortForwardManagerCallbacks = {},
    providers: SshPortForwardProvider[] = [
      new Ssh2PortForwardProvider(),
      new SystemSshPortForwardProvider()
    ]
  ) {
    this.callbacks = callbacks
    this.providers = providers
  }

  setCallbacks(callbacks: SshPortForwardManagerCallbacks): void {
    this.callbacks = callbacks
  }

  async addForward(
    connectionId: string,
    conn: SshConnection,
    localPort: number,
    remoteHost: string,
    remotePort: number,
    label?: string
  ): Promise<PortForwardEntry> {
    const id = `pf-${this.nextId++}`
    return this.runOperation(id, connectionId, (operation) =>
      this.addForwardWithId(
        id,
        connectionId,
        conn,
        localPort,
        remoteHost,
        remotePort,
        label,
        operation
      )
    )
  }

  private async runOperation(
    id: string,
    connectionId: string,
    run: (operation: PortForwardOperation) => Promise<PortForwardEntry>
  ): Promise<PortForwardEntry> {
    const completion = Promise.withResolvers<void>()
    const operation: PortForwardOperation = {
      id,
      connectionId,
      cancelled: false,
      completion: completion.promise
    }
    void completion.promise.catch(() => {})
    this.operations.add(operation)
    try {
      return await run(operation)
    } finally {
      this.operations.delete(operation)
      if (operation.cleanupFailure) {
        completion.reject(operation.cleanupFailure.error)
      } else {
        completion.resolve()
      }
    }
  }

  private cancelOperations(matches: (operation: PortForwardOperation) => boolean): Promise<void>[] {
    const completions: Promise<void>[] = []
    for (const operation of this.operations) {
      if (matches(operation)) {
        operation.cancelled = true
        completions.push(operation.completion)
      }
    }
    return completions
  }

  private assertOperationCurrent(operation: PortForwardOperation): void {
    if (operation.cancelled) {
      throw new Error('SSH port forward was removed before startup completed')
    }
  }

  private async addForwardWithId(
    id: string,
    connectionId: string,
    conn: SshConnection,
    localPort: number,
    remoteHost: string,
    remotePort: number,
    label: string | undefined,
    operation: PortForwardOperation
  ): Promise<PortForwardEntry> {
    this.assertOperationCurrent(operation)
    const provider = this.providers.find((candidate) => candidate.canHandle(conn))
    if (!provider) {
      throw new Error('SSH connection is not established')
    }

    let forward: StartedPortForward | null = null
    forward = await provider.start(conn, {
      id,
      connectionId,
      localHost: '127.0.0.1',
      localPort,
      remoteHost,
      remotePort,
      label,
      onUnexpectedClose: (entry, reason) => {
        const active = this.forwards.get(id)
        if (active !== forward) {
          return
        }
        this.forwards.delete(id)
        this.callbacks.onForwardClosed?.(entry, reason)
      }
    })
    if (operation.cancelled) {
      try {
        await forward.close()
      } catch (error) {
        operation.cleanupFailure = { error }
        throw error
      }
      this.assertOperationCurrent(operation)
    }
    this.forwards.set(id, forward)
    return forward.entry
  }

  async updateForward(
    id: string,
    conn: SshConnection,
    localPort: number,
    remoteHost: string,
    remotePort: number,
    label?: string
  ): Promise<PortForwardEntry> {
    const existing = this.forwards.get(id)
    if (!existing) {
      throw new Error(`Port forward "${id}" not found`)
    }
    return this.runOperation(id, existing.entry.connectionId, async (operation) => {
      const oldEntry = { ...existing.entry }

      // Closing must settle before the replacement binds the same local port.
      await this.removeForwardAsync(id, operation)
      this.assertOperationCurrent(operation)
      try {
        return await this.addForwardWithId(
          oldEntry.id,
          oldEntry.connectionId,
          conn,
          localPort,
          remoteHost,
          remotePort,
          label,
          operation
        )
      } catch (err) {
        if (operation.cancelled) {
          throw err
        }
        try {
          await this.addForwardWithId(
            oldEntry.id,
            oldEntry.connectionId,
            conn,
            oldEntry.localPort,
            oldEntry.remoteHost,
            oldEntry.remotePort,
            oldEntry.label,
            operation
          )
        } catch {
          // best-effort rollback
        }
        throw err
      }
    })
  }

  removeForward(id: string): PortForwardEntry | null {
    this.cancelOperations((operation) => operation.id === id)
    const forward = this.forwards.get(id)
    if (!forward) {
      return null
    }
    forward.dispose()
    this.forwards.delete(id)
    return forward.entry
  }

  async removeForwardAndWait(id: string): Promise<PortForwardEntry | null> {
    return this.removeForwardAsync(id)
  }

  // Why: server.close()/process exit are async — callers that need to rebind
  // the same port (update/reconnect) must wait until the owner fully releases it.
  private async removeForwardAsync(
    id: string,
    excludedOperation?: PortForwardOperation
  ): Promise<PortForwardEntry | null> {
    const completions = this.cancelOperations(
      (operation) => operation !== excludedOperation && operation.id === id
    )
    const forward = this.forwards.get(id)
    if (!forward) {
      await Promise.all(completions)
      return null
    }
    this.forwards.delete(id)
    const closing = forward.close().catch((error: unknown) => {
      if (excludedOperation) {
        excludedOperation.cleanupFailure = { error }
      }
      throw error
    })
    await Promise.all([closing, ...completions])
    return forward.entry
  }

  listForwards(connectionId?: string): PortForwardEntry[] {
    const entries: PortForwardEntry[] = []
    for (const { entry } of this.forwards.values()) {
      if (!connectionId || entry.connectionId === connectionId) {
        entries.push(entry)
      }
    }
    return entries
  }

  async removeAllForwards(connectionId: string): Promise<void> {
    const completions = this.cancelOperations(
      (operation) => operation.connectionId === connectionId
    )
    const toRemove = [...this.forwards.entries()]
      .filter(([, { entry }]) => entry.connectionId === connectionId)
      .map(([id]) => id)
    await Promise.all([...toRemove.map((id) => this.removeForwardAsync(id)), ...completions])
  }

  dispose(): void {
    this.cancelOperations(() => true)
    const ids = [...this.forwards.keys()]
    for (const id of ids) {
      this.removeForward(id)
    }
  }
}
