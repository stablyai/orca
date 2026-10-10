import { AgentSessionAcquisitionRootExitObservedError } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { ProviderAcquisitionStarts } from '../provider-process/provider-acquisition-starts'
import { AcpConnectionClosedError } from './acp-errors'
import {
  acpStartupFailure,
  endAcpStartingSession,
  type AcpStartingSession,
  type AcpStructuredChild
} from './acp-structured-child'
import { waitForAcpExit, type AcpStructuredConnection } from './acp-structured-connection'
import { closeAcpSessionJournal, endAcpStructuredSession } from './acp-structured-session'
import {
  ACP_STOP_GRACE_MS,
  type AcpStructuredSessionAdapterDeps
} from './acp-structured-session-adapter-deps'
import { windDownAcpTurn } from './acp-structured-stop'

export class AcpStructuredChildren {
  readonly sessions = new Map<string, AcpStructuredChild>()
  readonly starts = new ProviderAcquisitionStarts<AcpStructuredConnection>()
  constructor(private readonly deps: AcpStructuredSessionAdapterDeps) {}
  /** A requested close: proven by the root's exit; a tree not proven gone is the caller's to report. */
  async close(sessionId: string): Promise<boolean> {
    const connection = this.sessions.get(sessionId)?.connection
    const closed = await this.stop(sessionId, true)
    if (closed && connection?.processTreeUnproven) {
      throw new AgentSessionAcquisitionRootExitObservedError(
        new Error(
          `${this.deps.spec.agent} ACP agent exited, but its process tree was not proven gone`
        )
      )
    }
    return closed
  }

  /** True only once every child is proven gone, or when this adapter runs none for the session:
   *  a failed start's child, and the session's own. */
  async stop(sessionId: string, requested = true): Promise<boolean> {
    const [failedStart, session] = await Promise.all([
      this.starts.stopFailed(sessionId),
      this.stopSession(sessionId, requested)
    ])
    return failedStart && session
  }

  private async stopSession(sessionId: string, requested: boolean): Promise<boolean> {
    const session = this.sessions.get(sessionId)
    if (!session || session.ended) {
      return true
    }
    if (session.phase === 'starting') {
      session.closeRequested ||= requested && session.journalClosed === null
      session.dispose()
      session.closing ??= session.connection
        .close()
        .then((proven) => {
          if (proven) {
            this.finish(session, session.exitObservedAt ?? this.now())
          }
          return proven
        })
        .finally(() => {
          session.closing = undefined
        })
      return session.closing
    }
    if (requested && session.journalClosed === null) {
      // A close, dispose or quit ends a running turn as a Stop does before the child goes.
      session.closeRequested = true
      await windDownAcpTurn(session, this.stopGraceMs())
      if (session.ended) {
        return true
      }
    }
    // A connection loss already decided why the child ends; a later stop does not relabel it.
    if (session.journalClosed === null) {
      session.closeRequested ||= requested
      session.lane.flush()
    }
    const proven = await session.connection.close()
    if (proven) {
      this.finish(session, session.exitObservedAt ?? this.now())
    }
    return proven
  }

  /** The child's exit is proven: the host hears it, and nothing of the child stays here. */
  finish(session: AcpStructuredChild, observedAt: number): void {
    if (session.phase === 'starting') {
      endAcpStartingSession(session, observedAt, this.deps.onEvent)
    } else {
      endAcpStructuredSession(session, observedAt, this.deps.onEvent)
    }
    if (this.sessions.get(session.sessionId) === session) {
      this.sessions.delete(session.sessionId)
    }
  }

  /** The connection broke while the child may still run: nothing more it says can be journaled, so
   *  the journal closes now and the child is stopped; the host hears `ended` once that is proven. */
  connectionLost(session: AcpStructuredChild | null, error: Error): void {
    if (
      !session ||
      this.sessions.get(session.sessionId) !== session ||
      session.journalClosed !== null
    ) {
      return
    }
    if (session.phase === 'starting') {
      void this.startupFailed(session, error)
      return
    }
    closeAcpSessionJournal(
      session,
      `${session.spec.agent} ACP connection closed: ${error.message || error.name}`
    )
    void this.stop(session.sessionId, false)
  }

  async startupFailed(session: AcpStartingSession, error: unknown): Promise<void> {
    if (session.ended || session.closeRequested || session.journalClosed !== null) {
      return
    }
    session.failure = acpStartupFailure(session, error)
    session.journalClosed = error instanceof Error ? error.message : String(error)
    session.dispose()
    if (error instanceof AcpConnectionClosedError) {
      await waitForAcpExit(session.connection, this.stopGraceMs(), new AbortController().signal)
    }
    if (session.ended) {
      return
    }
    try {
      if (!(await this.stopSession(session.sessionId, false))) {
        this.deps.logger?.warn('ACP startup child exit remains unproven', {
          scope: 'acp-startup-close',
          sessionId: session.sessionId
        })
      }
    } catch (closeError) {
      this.deps.logger?.warn('ACP startup child could not be stopped', {
        scope: 'acp-startup-close',
        sessionId: session.sessionId,
        error: closeError
      })
    }
  }

  private stopGraceMs(): number {
    return this.deps.stopGraceMs ?? ACP_STOP_GRACE_MS
  }
  private now(): number {
    return (this.deps.now ?? Date.now)()
  }
}
