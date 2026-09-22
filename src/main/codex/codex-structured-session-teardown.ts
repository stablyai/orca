// Stopping one Codex app-server child, in the four ways the host asks for it.
//
// Every path funnels through `settled` so the ephemeral surfaces a closed
// session owns are cleared exactly once, and only when the child was actually
// proven stopped — a refused close leaves the session indexed for a retry.

import type { AgentSessionBackgroundTaskState } from '../../shared/agent-session-wire'
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
  onBackgroundTasksChanged?: (
    sessionId: string,
    state: AgentSessionBackgroundTaskState | null
  ) => void
  forgetNotificationRetries: (sessionId: string) => void
}

export class CodexStructuredSessionTeardown {
  constructor(private readonly deps: CodexStructuredSessionTeardownDeps) {}

  close = async (sessionId: string): Promise<boolean> => {
    const closed = await closeCodexSession(
      sessionId,
      this.deps.sessions,
      this.deps.acquisitions,
      this.deps.onEvent
    )
    return this.settled(sessionId, closed)
  }

  forceClose = async (sessionId: string): Promise<boolean> => {
    const closed = await closeCodexPublishedSession(
      this.deps.sessions,
      sessionId,
      this.deps.onEvent,
      { allowFailedSettlement: true, requestedClose: false }
    )
    return this.settled(sessionId, closed)
  }

  /** Terminates this exact child as an unexpected death. Every ownership check
   *  stays here so a stale caller cannot close a replacement child. */
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
      allowFailedSettlement: true,
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
      // Explicit null, not silence: the state reader answers `undefined` once
      // the session leaves the map, which every channel reads as "unchanged"
      // and would leave the last roster on screen.
      this.deps.onBackgroundTasksChanged?.(sessionId, null)
    }
    return closed
  }
}
