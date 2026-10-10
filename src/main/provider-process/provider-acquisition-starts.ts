// The adapter's starts: each acquire under way, stopped when the host aborts its signal (a close,
// a Stop that must not wait behind it, or quit), and each failed start's connection until its
// process's exit is proven, so the next start or quit retries that same connection's close instead
// of answering for a process it no longer knows (and never spawns a second one meanwhile).

import type { ProviderProcessCloseResult } from './provider-process-close'

export type ProviderAcquisitionConnection = {
  close(): Promise<boolean | ProviderProcessCloseResult>
  onExit(listener: () => void): void
}

export type ProviderStartAttempt<Connection extends ProviderAcquisitionConnection> = {
  /** The host's: the start's one canceller. */
  readonly signal: AbortSignal
  connection: Connection | null
  /** What the signal's abort does while the start runs; detached once it ends. */
  readonly stopConnection: () => void
}

export class ProviderAcquisitionStarts<Connection extends ProviderAcquisitionConnection> {
  private readonly failed = new Map<string, Connection>()

  /** Registered before anything awaits, so an abort from here on stops this start. */
  begin(signal: AbortSignal | undefined): ProviderStartAttempt<Connection> {
    const attempt: ProviderStartAttempt<Connection> = {
      signal: signal ?? new AbortController().signal,
      connection: null,
      stopConnection: () => void attempt.connection?.close().catch(() => false)
    }
    attempt.signal.addEventListener('abort', attempt.stopConnection, { once: true })
    return attempt
  }

  /** The start has its connection; one already aborted goes as soon as it exists. */
  track(attempt: ProviderStartAttempt<Connection>, connection: Connection): void {
    attempt.connection = connection
    if (attempt.signal.aborted) {
      void connection.close().catch(() => false)
    }
  }

  /** A connection the start handed over is the session's: an abort after this goes through its
   *  stop, which knows the close was asked for, not this listener, which would read as a crash. */
  end(attempt: ProviderStartAttempt<Connection>): void {
    attempt.signal.removeEventListener('abort', attempt.stopConnection)
  }

  /** A failed start whose process is not proven gone keeps its connection until its exit is. */
  retainFailed(sessionId: string, connection: Connection): void {
    this.failed.set(sessionId, connection)
    connection.onExit(() => {
      if (this.failed.get(sessionId) === connection) {
        this.failed.delete(sessionId)
      }
    })
  }

  /** Asks a failed start's connection to close again: true once none is left unproven. */
  async stopFailed(sessionId: string): Promise<boolean> {
    const connection = this.failed.get(sessionId)
    if (!connection) {
      return true
    }
    const result = await connection.close().catch(() => false)
    const proven = typeof result === 'boolean' ? result : result.root === 'exited'
    if (proven && this.failed.get(sessionId) === connection) {
      this.failed.delete(sessionId)
    }
    return proven
  }

  failedSessionIds(): string[] {
    return [...this.failed.keys()]
  }
}
