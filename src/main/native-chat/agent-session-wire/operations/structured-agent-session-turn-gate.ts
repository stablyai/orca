// Lets the runtime refuse new turns for chats it has closed to them (a bot chat a person ended),
// checked where every send, compaction and queued message is accepted.
import type { AgentSessionWireRefusal } from '../../../../shared/agent-session/failures/agent-session-wire-refusals'

type TurnGate = (sessionId: string) => AgentSessionWireRefusal | null

let gate: TurnGate | null = null

/** Installed once by the runtime; null removes it. */
export function installStructuredAgentSessionTurnGate(next: TurnGate | null): void {
  gate = next
}

export function structuredAgentSessionTurnRefusal(
  sessionId: string
): { ok: false; refusal: AgentSessionWireRefusal } | null {
  const refusal = gate?.(sessionId) ?? null
  return refusal ? { ok: false, refusal } : null
}
