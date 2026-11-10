// Retain failed connections until exit is proven so retries and quit can close the same process.

import type { ProviderProcessCloseResult } from './provider-process-close'

export type ProviderAcquisitionConnection = {
  readonly lastCloseResult?: ProviderProcessCloseResult | null
  close(): Promise<boolean | ProviderProcessCloseResult>
  onExit(listener: () => void): void
}

export type ProviderStartAttempt<Connection extends ProviderAcquisitionConnection> = {
  /** Host-owned cancellation for this acquisition. */
  readonly signal: AbortSignal
  connection: Connection | null
  /** Detached when acquisition hands the connection to its session. */
  readonly stopConnection: () => void
}

export class ProviderAcquisitionStarts<Connection extends ProviderAcquisitionConnection> {
  private readonly failed = new Map<string, Connection>()

  /** Install cancellation before acquisition can yield. */
  begin(signal: AbortSignal | undefined): ProviderStartAttempt<Connection> {
    const attempt: ProviderStartAttempt<Connection> = {
      signal: signal ?? new AbortController().signal,
      connection: null,
      stopConnection: () => void attempt.connection?.close().catch(() => false)
    }
    attempt.signal.addEventListener('abort', attempt.stopConnection, { once: true })
    return attempt
  }

  /** Honor cancellation that arrived before the connection existed. */
  track(attempt: ProviderStartAttempt<Connection>, connection: Connection): void {
    attempt.connection = connection
    if (attempt.signal.aborted) {
      void connection.close().catch(() => false)
    }
  }

  /** Session Stop owns cancellation after handoff; this listener would make it look like a crash. */
  end(attempt: ProviderStartAttempt<Connection>): void {
    attempt.signal.removeEventListener('abort', attempt.stopConnection)
  }

  retainFailed(sessionId: string, connection: Connection): void {
    this.failed.set(sessionId, connection)
    connection.onExit(() => {
      if (this.failed.get(sessionId) === connection) {
        this.failed.delete(sessionId)
      }
    })
  }

  /** Retry the retained connection; true means no unproven process remains. */
  async stopFailed(sessionId: string): Promise<boolean> {
    const connection = this.failed.get(sessionId)
    if (!connection) {
      return true
    }
    const result = await connection.close().catch(() => false)
    const proven =
      typeof result === 'boolean'
        ? result
        : result.root === 'exited' || result.killDelivered === true
    if (proven && this.failed.get(sessionId) === connection) {
      this.failed.delete(sessionId)
    }
    return proven
  }

  failedConnection(sessionId: string): Connection | undefined {
    return this.failed.get(sessionId)
  }

  failedSessionIds(): string[] {
    return [...this.failed.keys()]
  }
}
