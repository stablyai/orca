import { readInjectedAgentSessionId } from '../../shared/agent-session/lifecycle/launch/agent-session-caller-env'

/** Run from a native chat's agent: name that chat, so the host shows the saved automation in it. */
export function callerChat(): { callerSessionId?: string } {
  const sessionId = readInjectedAgentSessionId()
  return sessionId ? { callerSessionId: sessionId } : {}
}

/** The terminal and chat a create runs from; a session id names a caller only on its own host. */
export function cliCaller(
  callerTerminalHandle: string | undefined,
  isRemote: boolean
): { callerTerminalHandle: string | undefined; callerAgentSessionId?: string } {
  const sessionId = readInjectedAgentSessionId()
  return {
    callerTerminalHandle,
    ...(sessionId && !isRemote ? { callerAgentSessionId: sessionId } : {})
  }
}
