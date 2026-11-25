import type { CodexAcquisitionRegistry, CodexSession } from './codex-structured-session-state'

/** True while this generation's child, starting or live, has a pid and no proven exit. */
export function codexHoldsLiveProviderProcess(
  sessions: ReadonlyMap<string, CodexSession>,
  acquisitions: Pick<CodexAcquisitionRegistry, 'get'>
): (sessionId: string, acquisitionGeneration: string) => boolean {
  return (sessionId, acquisitionGeneration) => {
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
}
