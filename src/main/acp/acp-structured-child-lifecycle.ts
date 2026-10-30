import type { StructuredAgentSessionAdapter } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { ProviderAcquisitionStarts } from '../provider-process/provider-acquisition-starts'
import { isAcpReadySession, type AcpStructuredChild } from './acp-structured-child'
import {
  acpCloseReport,
  closeAcpAcquisition,
  type AcpStructuredConnection
} from './acp-structured-connection'
import { endAcpStructuredSession } from './acp-structured-session'
import {
  agentSessionFailureFact,
  providerDiagnostic,
  type SubmissionRejectionFact
} from '../../shared/agent-session-failure'
import { withProviderSpawnAbsence } from '../provider-process/provider-executable-missing'
import { providerStartupFailureFact } from '../native-chat/agent-session-wire/structured-agent-session-failure-text'
import {
  ACP_STOP_GRACE_MS,
  type AcpStructuredSessionAdapterDeps
} from './acp-structured-session-adapter-deps'
import {
  createStructuredAgentSessionLogger,
  neverThrowingStructuredAgentSessionLogger
} from '../native-chat/agent-session-wire/structured-agent-session-logger'
import { windDownAcpTurn } from './acp-structured-stop'

/** An agent that never ran names its missing CLI or folder; any other end while starting is its exit. */
function acpStartupEndFailure(session: AcpStructuredChild): SubmissionRejectionFact {
  const stderr = session.connection.stderrTail()
  if (session.closeRequested) {
    return agentSessionFailureFact('hostStopped', { detail: providerDiagnostic(stderr, 'person') })
  }
  const absence = session.connection.spawnAbsence
  return absence
    ? providerStartupFailureFact(withProviderSpawnAbsence(new Error(stderr), absence))
    : agentSessionFailureFact('providerExited', { detail: providerDiagnostic(stderr, 'person') })
}

export class AcpStructuredChildren {
  readonly sessions = new Map<string, AcpStructuredChild>()
  readonly starts = new ProviderAcquisitionStarts<AcpStructuredConnection>(closeAcpAcquisition)
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
    const child = connection ?? failed
    if (closed && child) {
      const report = acpCloseReport(child, await child.closeOutcome())
      if (report) {
        throw report
      }
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
    session.closing ??= (async () => {
      if (requested && session.journalClosed === null) {
        session.closeRequested = true
        if (isAcpReadySession(session)) {
          await windDownAcpTurn(session, this.stopGraceMs())
          if (session.ended) {
            return true
          }
        }
      }
      const outcome = await session.connection.closeOutcome()
      if (outcome.accepted && outcome.receive.state !== 'retained') {
        this.finish(session, session.exitObservedAt ?? this.now())
      }
      return outcome.accepted
    })().finally(() => {
      session.closing = undefined
    })
    return session.closing
  }

  finish(session: AcpStructuredChild, observedAt: number): void {
    observedAt = session.exitObservedAt ?? observedAt
    if (isAcpReadySession(session)) {
      endAcpStructuredSession(session, observedAt, this.deps.onEvent)
    } else if (!session.ended) {
      session.ended = true
      session.exitObservedAt = observedAt
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
        failure: acpStartupEndFailure(session)
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
    session.events?.observeExit?.(session.turns?.heldSends)
    session.journalClosed = isAcpReadySession(session)
      ? `${session.spec.agent} ACP connection closed: ${error.message || error.name}`
      : error.message || error.name
    this.stopAfterFailure(session.sessionId)
  }

  private stopGraceMs(): number {
    return this.deps.stopGraceMs ?? ACP_STOP_GRACE_MS
  }
  private now(): number {
    return (this.deps.now ?? Date.now)()
  }
}
