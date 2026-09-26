import type { AgentSessionPtyWriteRefusal } from '../../shared/agent-session-pty-write-admission'

export class StructuredSessionResumeRefusedError extends Error {
  readonly refusal: AgentSessionPtyWriteRefusal
  readonly displayMessage: string

  constructor(refusal: AgentSessionPtyWriteRefusal) {
    // Keep the legacy thrown contract while carrying copy for structured transports.
    super(refusal.code)
    this.name = 'StructuredSessionResumeRefusedError'
    this.refusal = refusal
    this.displayMessage = resumeRefusalDisplayMessage(refusal)
  }
}

function resumeRefusalDisplayMessage(refusal: AgentSessionPtyWriteRefusal): string {
  if (refusal.code === 'agent_session_ownership_unknown') {
    return 'Orca cannot confirm who owns this session yet. Reconnect to its host and try again.'
  }
  return refusal.ownerRuntimeKind === 'native'
    ? 'This session is already open in a chat. Open the chat to continue.'
    : 'This session is already open in a terminal. Switch to that terminal to continue.'
}
