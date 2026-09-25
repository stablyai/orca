// A wire refusal raised on a path that throws instead of returning a refusal body, such as the
// resume behind a hold. The code stays what a bare-code throw put on the wire; the message is the
// refusal's own, so a surface shows why it was refused instead of a code.

import type {
  AgentSessionWireRefusal,
  AgentSessionWireRefusalCode
} from '../../../shared/agent-session-wire'

export class AgentSessionRefusalError extends Error {
  readonly code: AgentSessionWireRefusalCode

  constructor(readonly refusal: AgentSessionWireRefusal) {
    super(refusal.message)
    this.name = 'AgentSessionRefusalError'
    this.code = refusal.code
  }
}
