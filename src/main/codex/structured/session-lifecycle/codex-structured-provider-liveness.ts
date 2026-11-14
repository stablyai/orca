import type { CodexAcquisitionRegistry, CodexSession } from './codex-structured-session-state'

/** Whether this exact generation's app-server child is still alive, starting or published. */
export const codexLiveProviderProcess =
  (sessions: ReadonlyMap<string, CodexSession>, acquisitions: CodexAcquisitionRegistry) =>
  (sessionId: string, acquisitionGeneration: string): boolean => {
    const session = sessions.get(sessionId)
    const starting = acquisitions.get(sessionId)
    if (starting?.acquisitionGeneration === acquisitionGeneration) {
      return !starting.exitProven && starting.window.connection?.pid !== undefined
    }
    return (
      session?.acquisitionGeneration === acquisitionGeneration &&
      session.connection.pid !== undefined &&
      !session.ended &&
      session.exitObservedAt === undefined
    )
  }
