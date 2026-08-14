import type {
  CodexSession,
  CodexStructuredSessionAdapterDeps
} from './codex-structured-session-state'

export async function invalidateTrustedUserTurnWriters(
  input: { sourceSessionId: string },
  sessions: ReadonlyMap<string, CodexSession>,
  deps: Pick<CodexStructuredSessionAdapterDeps, 'requestTimeoutMs' | 'writeAuthority'>,
  terminateSession: (sessionId: string) => Promise<void>
): Promise<void> {
  const authority = deps.writeAuthority
  if (!authority) {
    return
  }
  const source = sessions.get(input.sourceSessionId)
  const writerSessionIds = [...sessions]
    .filter(
      ([sessionId, session]) =>
        session.effectIsolation === 'local-structured-write' &&
        !(
          sessionId === input.sourceSessionId &&
          source?.effectIsolation === 'local-structured-write'
        )
    )
    .map(([sessionId]) => sessionId)
  await Promise.all(
    writerSessionIds.map(async (sessionId) => {
      const session = sessions.get(sessionId)
      if (!session) {
        return
      }
      const active = authority.activeTurn(sessionId)
      authority.invalidateTurnEpoch(sessionId)
      if (!active) {
        return
      }
      await session.connection
        .request(
          'turn/interrupt',
          { threadId: active.threadId, turnId: active.turnId },
          { timeoutMs: deps.requestTimeoutMs }
        )
        .catch(() => undefined)
      await terminateSession(sessionId).catch(() => undefined)
    })
  )
}
