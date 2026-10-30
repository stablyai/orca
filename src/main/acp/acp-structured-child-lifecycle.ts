import type { StructuredAgentSessionAdapter } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
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
import {
  createStructuredAgentSessionLogger,
  neverThrowingStructuredAgentSessionLogger
} from '../native-chat/agent-session-wire/structured-agent-session-logger'
import { windDownAcpTurn } from './acp-structured-stop'

export class AcpStructuredChildren {
  readonly sessions = new Map<string, AcpStructuredChild>()
  readonly starts = new ProviderAcquisitionStarts<AcpStructuredConnection>()
  constructor(private readonly deps: AcpStructuredSessionAdapterDeps) {}
  capturePendingOutput: StructuredAgentSessionAdapter['capturePendingOutput'] = (input) => {
    const session = this.sessions.get(input.sessionId)
    if (
      !session ||
      !isAcpReadySession(session) ||
      session.fence !== input.fence ||
      session.acquisitionGeneration !== input.generation
    ) {
      return undefined
    }
    const { turns, lane } = session
    const pending = turns.capturePendingSend(input.clientMessageId)
    return () =>
      session.journalClosed === null &&
      (pending() || lane.hasPendingDiagnostic(input.clientMessageId))
  }

  stopAfterFailure(sessionId: string): void {
    void this.stop(sessionId, false).catch((error: unknown) => {
      const logger = neverThrowingStructuredAgentSessionLogger(
        this.deps.logger ?? createStructuredAgentSessionLogger()
      )
      logger.warn('ACP failed-child cleanup failed', {
        scope: 'acp-child-cleanup',
        sessionId,
        error
      })
    })
  }

  /** Requires root exit; reports unproven descendant cleanup separately. */
  async close(sessionId: string, requested = true): Promise<boolean> {
    const connection = this.sessions.get(sessionId)?.connection
    const failed = this.starts.failedConnection(sessionId)
    const closed = await this.stop(sessionId, requested)
    const result = connection?.lastCloseResult ?? failed?.lastCloseResult
    if (closed && result?.killDelivered && result.root !== 'exited') {
      throw new AgentSessionAcquisitionRootExitObservedError(
        new Error('ACP writer killed'),
        'kill-delivered'
      )
    }
    if (closed && connection?.processTreeUnproven) {
      throw new AgentSessionAcquisitionRootExitObservedError(
        new Error(
          `${this.deps.spec.agent} ACP agent exited, but its process tree was not proven gone`
        )
      )
    }
    return closed
  }

  /** Requires exit of both the failed-start child and the session child, if present. */
  async stop(sessionId: string, requested = true): Promise<boolean> {
    const [failedStart, session] = await Promise.all([
      this.starts.stopFailed(sessionId),
      this.stopSession(sessionId, requested)
    ])
    return failedStart && session
  }

  async closeAll(tasks: (Promise<boolean | void> | undefined)[]): Promise<void> {
    const ids = new Set([...this.sessions.keys(), ...this.starts.failedSessionIds()])
    // The host aborts in-progress starts before this teardown.
    const results = await Promise.allSettled([
      ...[...ids].map((sessionId) => this.stop(sessionId, true)),
      ...tasks
    ])
    const failure = results.find((result) => result.status === 'rejected')
    if (failure?.status === 'rejected') {
      throw failure.reason
    }
    if (results.some((result) => result.status === 'fulfilled' && result.value === false)) {
      throw new Error('an ACP agent child could not be proven stopped')
    }
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
      // Allow the running turn to settle before closing the process.
      session.closeRequested = true
      await windDownAcpTurn(session, this.stopGraceMs())
      if (session.ended) {
        return true
      }
    }
    // Preserve a connection loss's cause across later Stop calls.
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

  finish(session: AcpStructuredChild, observedAt: number): void {
    if (isAcpReadySession(session)) {
      endAcpStructuredSession(session, observedAt, this.deps.onEvent)
    } else if (!session.ended) {
      session.ended = true
      session.exitObservedAt = observedAt
      session.dispose()
      this.deps.onEvent?.({
        type: 'ended',
        ...(session.connection.lastCloseResult?.killDelivered && !session.connection.exited
          ? { deathEvidenceKind: 'kill-delivered' as const }
          : {}),
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

  /** Close the journal on protocol loss; notify the host after process exit is proven. */
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
    this.stopAfterFailure(session.sessionId)
  }

  private stopGraceMs(): number {
    return this.deps.stopGraceMs ?? ACP_STOP_GRACE_MS
  }
  private now(): number {
    return (this.deps.now ?? Date.now)()
  }
}
