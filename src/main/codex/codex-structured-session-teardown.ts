import { AgentSessionAcquisitionRootExitObservedError } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { StructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'
import {
  closeAllCodexSessions,
  closeCodexPublishedSession,
  closeCodexSession
} from './codex-structured-session-close'
import type {
  CodexAcquisitionRegistry,
  CodexSession,
  CodexStructuredSessionEvent
} from './codex-structured-session-state'

export type CodexStructuredSessionTeardownDeps = {
  sessions: Map<string, CodexSession>
  acquisitions: CodexAcquisitionRegistry
  onEvent?: (event: CodexStructuredSessionEvent) => void
  logger?: StructuredAgentSessionLogger
  forgetNotificationRetries: (sessionId: string) => void
}

export class CodexStructuredSessionTeardown {
  constructor(private readonly deps: CodexStructuredSessionTeardownDeps) {}

  close = async (sessionId: string): Promise<boolean> => {
    const connection =
      this.deps.sessions.get(sessionId)?.connection ??
      this.deps.acquisitions.get(sessionId)?.window.connection
    const closed = this.settled(
      sessionId,
      await closeCodexSession(
        sessionId,
        this.deps.sessions,
        this.deps.acquisitions,
        this.deps.onEvent,
        this.deps.logger,
        true
      )
    )
    if (closed && connection?.processTreeUnproven) {
      // Root exit settles the close; report unproven descendants separately.
      throw new AgentSessionAcquisitionRootExitObservedError(
        new Error('codex app-server exited, but its process tree was not proven gone')
      )
    }
    return closed
  }

  forceClose = async (sessionId: string): Promise<boolean> => {
    const closed = await closeCodexSession(
      sessionId,
      this.deps.sessions,
      this.deps.acquisitions,
      this.deps.onEvent,
      this.deps.logger,
      false
    )
    return this.settled(sessionId, closed)
  }

  /** Ownership checks prevent stale callers from killing replacement children. */
  forceCloseUnexpected = (
    sessionId: string,
    fence: number,
    acquisitionGeneration: string,
    reason: Error
  ): Promise<boolean> => {
    const session = this.deps.sessions.get(sessionId)
    if (
      !session ||
      session.ended ||
      session.fence !== fence ||
      session.acquisitionGeneration !== acquisitionGeneration
    ) {
      return Promise.resolve(false)
    }
    return closeCodexPublishedSession(this.deps.sessions, sessionId, this.deps.onEvent, {
      requestedClose: false,
      expectedFence: fence,
      expectedAcquisitionGeneration: acquisitionGeneration,
      unexpectedReason: reason
    }).then((closed) => this.settled(sessionId, closed))
  }

  closeAll = (): Promise<void> =>
    closeAllCodexSessions(this.deps.sessions, this.deps.acquisitions, (sessionId) =>
      this.close(sessionId)
    )

  private settled(sessionId: string, closed: boolean): boolean {
    if (closed) {
      this.deps.forgetNotificationRetries(sessionId)
    }
    return closed
  }
}
