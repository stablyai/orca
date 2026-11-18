import type { StructuredAgentSessionAdapter } from '../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import type { AgentSessionStopOutcome } from '../native-chat/agent-session-wire/providers/structured-agent-session-adapter-stop'
import type { TraexSession } from './traex-session'
import { pauseTraexThreadGoal } from './traex-thread-goal'

export async function cancelTraexTurn(
  session: TraexSession,
  input: Parameters<StructuredAgentSessionAdapter['cancelTurn']>[0]
): ReturnType<StructuredAgentSessionAdapter['cancelTurn']> {
  const journalTurn = session.timeline?.openTurnId
  const native = session.activeTurn
  if (input.turnId && input.turnId !== journalTurn) {
    return { cancelled: false }
  }
  const facts: AgentSessionStopOutcome = {
    pause: 'unconfirmed',
    interrupt: 'not-needed',
    root: 'unproven',
    workload: 'unproven',
    errors: []
  }
  let paused = false
  const pause = async () => {
    try {
      paused = (await pauseTraexThreadGoal(session)) || paused
      facts.pause = paused ? 'acknowledged' : 'not-needed'
    } catch (error) {
      facts.pause = 'unconfirmed'
      facts.errors.push(error)
    }
  }
  await pause()
  let cancelled = paused
  let turnMayOpen = false
  const current = journalTurn === session.timeline?.openTurnId && native === session.activeTurn
  if (native && current) {
    try {
      await session.connection.request(
        'turn/interrupt',
        { threadId: session.threadId, turnId: native },
        { timeoutMs: 5_000 }
      )
      session.prompts?.withdraw(undefined, native)
      cancelled = true
      facts.interrupt = 'accepted'
    } catch (error) {
      facts.interrupt = 'unconfirmed'
      facts.errors.push(error)
    }
  } else if (!native && current && session.pending.size > 0) {
    // The provider turn may still open; closing the session would end unrelated work.
    facts.interrupt = 'unconfirmed'
    turnMayOpen = true
  }
  if (facts.pause !== 'not-needed') {
    await pause()
  }
  return {
    cancelled,
    ...(journalTurn ? { turnId: journalTurn } : {}),
    stop: facts,
    ...(turnMayOpen ? { refusal: { turnMayOpen: true as const } } : {})
  }
}
