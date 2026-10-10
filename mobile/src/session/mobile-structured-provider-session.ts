import type { AgentProviderSessionMetadata } from '../../../src/shared/agent-session-resume'

/** Bounded like the hook's transcript cache: a chat read once keeps the id a terminal resume
 *  needs, and the oldest chat is dropped instead of growing for the app's lifetime. */
const MAX_RETAINED_PROVIDER_SESSIONS = 32

export type MobileProviderSessions = ReadonlyMap<string, AgentProviderSessionMetadata>

export const NO_MOBILE_PROVIDER_SESSIONS: MobileProviderSessions = new Map()

function sameProviderSession(
  previous: AgentProviderSessionMetadata | undefined,
  reported: AgentProviderSessionMetadata
): boolean {
  return (
    previous?.key === reported.key &&
    previous.id === reported.id &&
    previous.transcriptPath === reported.transcriptPath
  )
}

/**
 * What the host last named as a chat's provider session, keyed by the chat's own session id — the
 * only source a terminal resume has, since the tab carries no provider identity. A read that names
 * none keeps the previous value: only the host mints the id, and it does not change for one chat.
 */
export function rememberMobileProviderSession(
  current: MobileProviderSessions,
  sessionId: string,
  reported: AgentProviderSessionMetadata | undefined
): MobileProviderSessions {
  if (!reported || sameProviderSession(current.get(sessionId), reported)) {
    return current
  }
  const updated = new Map(current)
  updated.delete(sessionId)
  updated.set(sessionId, reported)
  while (updated.size > MAX_RETAINED_PROVIDER_SESSIONS) {
    const oldest = updated.keys().next().value
    if (oldest === undefined) {
      break
    }
    updated.delete(oldest)
  }
  return updated
}
