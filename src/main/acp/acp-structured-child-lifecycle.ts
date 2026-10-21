import { AgentSessionAcquisitionRootExitObservedError } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { ProviderAcquisitionStarts } from '../provider-process/provider-acquisition-starts'
import { isAcpReadySession, type AcpStructuredChild } from './acp-structured-child'
import type { AcpStructuredConnection } from './acp-structured-connection'
import { closeAcpSessionJournal, endAcpStructuredSession } from './acp-structured-session'
import { agentSessionFailureFact, providerDiagnostic } from '../../shared/agent-session-failure'
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
    if (!isAcpReadySession(session)) {
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
    if (isAcpReadySession(session)) {
      endAcpStructuredSession(session, observedAt, this.deps.onEvent)
    } else if (!session.ended) {
      session.ended = true
      session.exitObservedAt = observedAt
      session.dispose()
      this.deps.onEvent?.({
        type: 'ended',
        sessionId: session.sessionId,
        fence: session.fence,
        acquisitionGeneration: session.acquisitionGeneration,
        observedAt,
        cause: session.closeRequested ? 'requested-close' : 'unexpected-exit',
        reason:
          session.connection.stderrTail() || `${session.spec.agent} ACP agent ended while starting`,
        failure: agentSessionFailureFact(
          session.closeRequested ? 'hostStopped' : 'providerExited',
          {
            detail: providerDiagnostic(session.connection.stderrTail(), 'person')
          }
        )
      })
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
    if (!isAcpReadySession(session)) {
      session.journalClosed = error.message || error.name
      return
    }
    closeAcpSessionJournal(
      session,
      `${session.spec.agent} ACP connection closed: ${error.message || error.name}`,
      error
    )
    void this.stop(session.sessionId, false)
  }

  private stopGraceMs(): number {
    return this.deps.stopGraceMs ?? ACP_STOP_GRACE_MS
  }
  private now(): number {
    return (this.deps.now ?? Date.now)()
  }
}
